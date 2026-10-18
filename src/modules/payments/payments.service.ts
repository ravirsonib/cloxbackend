import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import {
  AssignmentStatus,
  JobStatus,
  PaymentEventStatus,
  PaymentEventType,
  ProposalStatus,
  SettlementLineStatus,
  SettlementRecipientType,
  SurchargeKind,
  SurchargeStatus,
  type Prisma,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AuditAction } from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TripsService } from '../trips/trips.service';
import { splitIncGst } from '../trips/geofence.util';
import { StripeService } from './stripe.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  /** Abandoned SCA / pending accept PaymentIntent TTL before auto-unwind. */
  private static readonly ACCEPT_SCA_TTL_MS = 45 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stripe: StripeService,
    @Inject(forwardRef(() => TripsService))
    private readonly trips: TripsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  idempotencyKey(jobId: string, proposalId: string) {
    return `accept:${jobId}:${proposalId}`;
  }

  /**
   * Model A accept: create Assignment PENDING + PaymentIntent once (idempotent).
   * Mock path auto-locks on success. Real path awaits webhook unless PI already succeeded.
   */
  async acceptProposal(
    principal: AuthenticatedPrincipal,
    jobId: string,
    proposalId: string,
  ) {
    this.ensureDatabase();
    if (principal.kind !== 'user' || principal.role !== 'SENDER') {
      throw new ForbiddenException('Sender required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { company: true },
    });
    if (!user?.companyId || !user.company) {
      throw new NotFoundException('Sender company not found');
    }
    if (!user.company.paymentReady || !user.company.stripeCustomerId) {
      throw new BadRequestException({
        message: 'Sender payment method not ready',
        code: 'SENDER_NOT_PAYMENT_READY',
      });
    }

    const key = this.idempotencyKey(jobId, proposalId);

    let existing = await this.prisma.paymentEvent.findUnique({
      where: { idempotencyKey: key },
      include: { job: { include: { assignment: true } } },
    });

    // Recover stuck accepts so a fresh attempt can proceed.
    if (existing) {
      const assignmentStatus = existing.job?.assignment?.status;
      const locked = assignmentStatus === AssignmentStatus.LOCKED;
      const ageMs = Date.now() - new Date(existing.createdAt).getTime();
      const scaTimedOut =
        !locked &&
        ageMs > PaymentsService.ACCEPT_SCA_TTL_MS &&
        existing.stripePaymentIntentId &&
        (existing.status === PaymentEventStatus.PENDING ||
          existing.status === PaymentEventStatus.REQUIRES_ACTION) &&
        assignmentStatus === AssignmentStatus.PENDING;

      const recoverableStatus =
        existing.status === PaymentEventStatus.FAILED ||
        (existing.status === PaymentEventStatus.PENDING &&
          !existing.stripePaymentIntentId) ||
        existing.status === PaymentEventStatus.CANCELLED;

      let deadPi = false;
      let liveSucceeded = false;
      if (
        !locked &&
        !recoverableStatus &&
        existing.stripePaymentIntentId &&
        (existing.status === PaymentEventStatus.PENDING ||
          existing.status === PaymentEventStatus.REQUIRES_ACTION) &&
        assignmentStatus === AssignmentStatus.PENDING
      ) {
        const piStatus = await this.stripe.retrievePaymentIntentStatus(
          existing.stripePaymentIntentId,
        );
        if (piStatus === 'succeeded') {
          liveSucceeded = true;
        } else if (piStatus === 'canceled') {
          deadPi = true;
        } else if (scaTimedOut && piStatus !== 'processing' && piStatus !== 'requires_action') {
          // Timed out and not mid-SCA / processing — safe to unwind.
          deadPi = true;
        }
        // scaTimedOut + requires_action/processing: keep waiting (do not orphan a live charge).
      }

      if (liveSucceeded && existing.stripePaymentIntentId) {
        await this.markPaidAndLock({
          paymentEventId: existing.id,
          paymentIntentId: existing.stripePaymentIntentId,
          source: 'accept_replay_pi_succeeded',
        });
        existing = await this.prisma.paymentEvent.findUnique({
          where: { idempotencyKey: key },
          include: { job: { include: { assignment: true } } },
        });
      } else if (!locked && (recoverableStatus || deadPi)) {
        if (existing.stripePaymentIntentId) {
          await this.stripe.cancelPaymentIntent(existing.stripePaymentIntentId);
        }
        await this.unwindFailedAccept(existing);
        existing = null;
      }
    }

    if (existing) {
      const base = this.buildAcceptResponse(existing, existing.job?.assignment ?? null, true);
      const needsSca =
        existing.status === PaymentEventStatus.REQUIRES_ACTION ||
        existing.status === PaymentEventStatus.PENDING;
      if (needsSca && existing.stripePaymentIntentId) {
        const clientSecret = await this.stripe.retrievePaymentIntentClientSecret(
          existing.stripePaymentIntentId,
        );
        return {
          ...base,
          clientSecret,
          publishableKey: this.stripe.publishableKey(),
          message: 'Idempotent replay — complete SCA with clientSecret if required',
        };
      }
      return base;
    }

    const job = await this.prisma.job.findFirst({
      where: { id: jobId, senderCompanyId: user.companyId },
      include: {
        proposals: { where: { id: proposalId } },
        assignment: true,
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    if (job.assignment) {
      throw new ConflictException({
        message: 'Job already has an assignment',
        code: 'JOB_ALREADY_ASSIGNED',
      });
    }
    if (job.status !== JobStatus.BIDDING && job.status !== JobStatus.PUBLISHED) {
      throw new BadRequestException('Job is not open for accept');
    }

    const proposal = job.proposals[0];
    if (!proposal || proposal.status !== ProposalStatus.SUBMITTED) {
      throw new NotFoundException('Proposal not found or not submittable');
    }

    const amountInc = proposal.amountIncGstCents;
    const amountEx = proposal.amountExGstCents;
    const amountGst = proposal.amountGstCents;

    const created = await this.prisma.$transaction(async (tx) => {
      const assignment = await tx.assignment.create({
        data: {
          jobId: job.id,
          proposalId: proposal.id,
          carrierCompanyId: proposal.carrierCompanyId,
          vehicleId: proposal.vehicleId,
          driverId: proposal.driverId,
          status: AssignmentStatus.PENDING,
        },
      });

      await tx.proposal.update({
        where: { id: proposal.id },
        data: { status: ProposalStatus.ACCEPTED },
      });

      // Expire conflicting proposals: same job OR same vehicle/driver on other open jobs
      const conflictPeers = await tx.proposal.findMany({
        where: {
          status: ProposalStatus.SUBMITTED,
          OR: [
            { jobId: job.id, id: { not: proposal.id } },
            ...(proposal.vehicleId
              ? [{ vehicleId: proposal.vehicleId, id: { not: proposal.id } }]
              : []),
            ...(proposal.driverId
              ? [{ driverId: proposal.driverId, id: { not: proposal.id } }]
              : []),
          ],
        },
      });
      if (conflictPeers.length > 0) {
        await tx.proposal.updateMany({
          where: { id: { in: conflictPeers.map((p) => p.id) } },
          data: { status: ProposalStatus.EXPIRED },
        });
      }

      await tx.job.update({
        where: { id: job.id },
        data: { status: JobStatus.ASSIGNED },
      });

      const paymentEvent = await tx.paymentEvent.create({
        data: {
          jobId: job.id,
          type: PaymentEventType.CHARGE,
          status: PaymentEventStatus.PENDING,
          amountExGstCents: amountEx,
          amountGstCents: amountGst,
          amountIncGstCents: amountInc,
          currency: 'AUD',
          idempotencyKey: key,
          metadata: {
            proposalId: proposal.id,
            assignmentId: assignment.id,
            acceptKey: key,
            conflictIds: conflictPeers.map((p) => p.id),
          },
        },
      });

      return { assignment, paymentEvent, conflictIds: conflictPeers.map((p) => p.id) };
    });

    for (const cid of created.conflictIds) {
      await this.audit.recordPlatform({
        action: AuditAction.PROPOSAL_EXPIRED_CONFLICT,
        actorUserId: user.id,
        entityType: 'Proposal',
        entityId: cid,
        metadata: { jobId, acceptedProposalId: proposalId },
      });
    }

    await this.audit.recordPlatform({
      action: AuditAction.PROPOSAL_ACCEPTED,
      actorUserId: user.id,
      entityType: 'Proposal',
      entityId: proposalId,
      metadata: { jobId, assignmentId: created.assignment.id },
    });

    let pi;
    try {
      pi = await this.stripe.createPaymentIntent({
        amountCents: amountInc,
        customerId: user.company.stripeCustomerId,
        paymentMethodId: user.company.stripeDefaultPaymentMethodId,
        // PE-scoped key so retries after unwind never hit a stale Stripe idempotency cache.
        idempotencyKey: `${key}:pe:${created.paymentEvent.id}`,
        metadata: {
          jobId,
          proposalId,
          assignmentId: created.assignment.id,
          paymentEventId: created.paymentEvent.id,
        },
      });
    } catch (err) {
      await this.prisma.paymentEvent.update({
        where: { id: created.paymentEvent.id },
        data: {
          status: PaymentEventStatus.FAILED,
          metadata: {
            ...((created.paymentEvent.metadata as Record<string, unknown>) ?? {}),
            error: err instanceof Error ? err.message : String(err),
            conflictIds: created.conflictIds,
          } as Prisma.InputJsonValue,
        },
      });
      await this.unwindFailedAccept({
        id: created.paymentEvent.id,
        jobId: job.id,
        status: PaymentEventStatus.FAILED,
        metadata: {
          proposalId: proposal.id,
          assignmentId: created.assignment.id,
          conflictIds: created.conflictIds,
        },
      });
      throw new BadRequestException({
        message: 'Failed to create PaymentIntent — accept rolled back; retry allowed',
        code: 'PAYMENT_INTENT_FAILED',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const peStatus =
      pi.status === 'succeeded'
        ? PaymentEventStatus.SUCCEEDED
        : pi.status === 'requires_action'
          ? PaymentEventStatus.REQUIRES_ACTION
          : PaymentEventStatus.PENDING;

    const paymentEvent = await this.prisma.paymentEvent.update({
      where: { id: created.paymentEvent.id },
      data: {
        stripePaymentIntentId: pi.id,
        status: peStatus,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.PAYMENT_INTENT_CREATED,
      actorUserId: user.id,
      entityType: 'PaymentEvent',
      entityId: paymentEvent.id,
      metadata: { pi: pi.id, status: pi.status, mock: pi.mock },
    });

    // Mock or already-succeeded PI: lock immediately (webhook is source of truth for live)
    if (pi.status === 'succeeded') {
      await this.markPaidAndLock({
        paymentEventId: paymentEvent.id,
        paymentIntentId: pi.id,
        source: pi.mock ? 'mock' : 'pi_immediate',
      });
    }

    const assignment = await this.prisma.assignment.findUnique({
      where: { id: created.assignment.id },
    });

    return {
      ...this.buildAcceptResponse(paymentEvent, assignment, false),
      clientSecret: pi.clientSecret,
      publishableKey: this.stripe.publishableKey(),
      stripeStatus: pi.status,
      mock: pi.mock,
      message:
        pi.status === 'succeeded'
          ? 'Payment succeeded — assignment locked'
          : pi.status === 'requires_action'
            ? 'Complete SCA with clientSecret'
            : 'Payment pending — wait for webhook',
    };
  }

  /** Resolve PI success — route CHARGE vs SURCHARGE by PaymentEvent.type / metadata. */
  async resolvePaymentIntentSucceeded(params: {
    paymentEventId: string;
    paymentIntentId: string;
    source: string;
  }) {
    const pe = await this.prisma.paymentEvent.findUnique({
      where: { id: params.paymentEventId },
    });
    if (!pe) return { skipped: true as const };
    if (pe.type === PaymentEventType.SURCHARGE) {
      return this.markSurchargePaid(params);
    }
    return this.markPaidAndLock(params);
  }

  /**
   * Create WAITING or MASS surcharge + PaymentIntent (idempotent).
   * Mock PI auto-marks paid. Used by trips mass/geofence and sender pay retry.
   */
  async createSurcharge(params: {
    jobId: string;
    tripId: string;
    kind: SurchargeKind;
    amountIncGstCents: number;
    idempotencyKey: string;
    stopProgressId?: string | null;
    metadata?: Record<string, unknown>;
    /** When true, create PE + Surcharge but do not charge yet (rare). Default charges. */
    chargeNow?: boolean;
  }): Promise<{
    id: string;
    jobId: string;
    tripId: string;
    kind: SurchargeKind;
    status: SurchargeStatus;
    amountExGstCents: number;
    amountGstCents: number;
    amountIncGstCents: number;
    [key: string]: unknown;
  }> {
    this.ensureDatabase();
    const existing = await this.prisma.surcharge.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
      include: { paymentEvent: true },
    });
    if (existing) {
      // Waiting dwell grows until a PaymentIntent exists — then freeze base row.
      // Further dwell after PI creates an additive sibling surcharge (T1).
      const piCreated = Boolean(existing.paymentEvent?.stripePaymentIntentId);
      if (
        existing.status === SurchargeStatus.PENDING_PAYMENT &&
        !piCreated &&
        params.amountIncGstCents > existing.amountIncGstCents
      ) {
        const amounts = splitIncGst(params.amountIncGstCents);
        const nextMeta = {
          ...((existing.metadata as Record<string, unknown>) ?? {}),
          ...(params.metadata ?? {}),
        } as Prisma.InputJsonValue;
        const nextPeMeta = {
          ...((existing.paymentEvent?.metadata as Record<string, unknown>) ?? {}),
          ...(params.metadata ?? {}),
        } as Prisma.InputJsonValue;
        const updated = await this.prisma.$transaction(async (tx) => {
          if (existing.paymentEventId) {
            await tx.paymentEvent.update({
              where: { id: existing.paymentEventId },
              data: {
                ...amounts,
                metadata: nextPeMeta,
              },
            });
          }
          return tx.surcharge.update({
            where: { id: existing.id },
            data: {
              ...amounts,
              metadata: nextMeta,
            },
            include: { paymentEvent: true },
          });
        });
        return this.mapSurcharge(updated);
      }

      if (
        params.kind === SurchargeKind.WAITING &&
        piCreated &&
        params.amountIncGstCents > existing.amountIncGstCents &&
        (existing.status === SurchargeStatus.PENDING_PAYMENT ||
          existing.status === SurchargeStatus.PAID)
      ) {
        const delta = params.amountIncGstCents - existing.amountIncGstCents;
        if (delta > 0) {
          return this.createSurcharge({
            ...params,
            amountIncGstCents: delta,
            idempotencyKey: `${params.idempotencyKey}:postpi:${params.amountIncGstCents}`,
            chargeNow: false,
            metadata: {
              ...(params.metadata ?? {}),
              parentSurchargeId: existing.id,
              accruedToCents: params.amountIncGstCents,
            },
          });
        }
      }

      return this.mapSurcharge(existing);
    }

    const job = await this.prisma.job.findUnique({
      where: { id: params.jobId },
      include: { senderCompany: true },
    });
    if (!job?.senderCompany) throw new NotFoundException('Job/sender not found');

    const amounts = splitIncGst(params.amountIncGstCents);
    const chargeNow = params.chargeNow !== false;

    const created = await this.prisma.$transaction(async (tx) => {
      const paymentEvent = await tx.paymentEvent.create({
        data: {
          jobId: params.jobId,
          type: PaymentEventType.SURCHARGE,
          status: PaymentEventStatus.PENDING,
          ...amounts,
          idempotencyKey: `pe:${params.idempotencyKey}`,
          metadata: {
            kind: params.kind,
            tripId: params.tripId,
            surchargeKind: params.kind,
            ...(params.metadata ?? {}),
          },
        },
      });
      const surcharge = await tx.surcharge.create({
        data: {
          jobId: params.jobId,
          tripId: params.tripId,
          kind: params.kind,
          status: SurchargeStatus.PENDING_PAYMENT,
          ...amounts,
          paymentEventId: paymentEvent.id,
          stopProgressId: params.stopProgressId ?? null,
          idempotencyKey: params.idempotencyKey,
          metadata: (params.metadata ?? undefined) as object | undefined,
        },
        include: { paymentEvent: true },
      });
      return { paymentEvent, surcharge };
    });

    await this.audit.recordPlatform({
      action: AuditAction.SURCHARGE_CREATED,
      entityType: 'Surcharge',
      entityId: created.surcharge.id,
      metadata: {
        kind: params.kind,
        amountIncGstCents: amounts.amountIncGstCents,
        tripId: params.tripId,
      },
    });

    if (!chargeNow) {
      return this.mapSurcharge(created.surcharge);
    }

    if (!job.senderCompany.stripeCustomerId) {
      throw new BadRequestException({
        message: 'Sender payment method not ready for surcharge',
        code: 'SENDER_NOT_PAYMENT_READY',
      });
    }

    return this.chargeSurcharge(created.surcharge.id, {
      customerId: job.senderCompany.stripeCustomerId,
      paymentMethodId: job.senderCompany.stripeDefaultPaymentMethodId,
    });
  }

  private mapSurcharge(s: {
    id: string;
    jobId: string;
    tripId: string;
    kind: SurchargeKind;
    status: SurchargeStatus;
    amountExGstCents: number;
    amountGstCents: number;
    amountIncGstCents: number;
    paymentEventId: string | null;
    stopProgressId: string | null;
    idempotencyKey: string;
    paidAt: Date | null;
    waivedAt: Date | null;
    metadata: unknown;
    paymentEvent?: {
      id: string;
      status: PaymentEventStatus;
      stripePaymentIntentId: string | null;
    } | null;
  }) {
    return {
      id: s.id,
      jobId: s.jobId,
      tripId: s.tripId,
      kind: s.kind,
      status: s.status,
      amountExGstCents: s.amountExGstCents,
      amountGstCents: s.amountGstCents,
      amountIncGstCents: s.amountIncGstCents,
      paymentEventId: s.paymentEventId,
      stopProgressId: s.stopProgressId,
      idempotencyKey: s.idempotencyKey,
      paidAt: s.paidAt,
      waivedAt: s.waivedAt,
      metadata: s.metadata,
      payment: s.paymentEvent
        ? {
            id: s.paymentEvent.id,
            status: s.paymentEvent.status,
            stripePaymentIntentId: s.paymentEvent.stripePaymentIntentId,
          }
        : null,
    };
  }

  async chargeSurcharge(
    surchargeId: string,
    stripe?: { customerId: string; paymentMethodId?: string | null },
  ) {
    this.ensureDatabase();
    const surcharge = await this.prisma.surcharge.findUnique({
      where: { id: surchargeId },
      include: {
        paymentEvent: true,
        job: { include: { senderCompany: true } },
      },
    });
    if (!surcharge?.paymentEvent) throw new NotFoundException('Surcharge not found');
    if (surcharge.status === SurchargeStatus.PAID || surcharge.status === SurchargeStatus.WAIVED) {
      return this.mapSurcharge(surcharge);
    }

    const customerId =
      stripe?.customerId ?? surcharge.job.senderCompany?.stripeCustomerId ?? null;
    const paymentMethodId =
      stripe?.paymentMethodId ?? surcharge.job.senderCompany?.stripeDefaultPaymentMethodId ?? null;
    if (!customerId) {
      throw new BadRequestException({
        message: 'Sender payment method not ready',
        code: 'SENDER_NOT_PAYMENT_READY',
      });
    }

    let pe = surcharge.paymentEvent;
    const peMeta = (pe.metadata as Record<string, unknown> | null) ?? {};
    let stripeAttempt = Number(peMeta.stripeAttempt ?? 0);
    if (
      pe.status === PaymentEventStatus.FAILED ||
      pe.status === PaymentEventStatus.CANCELLED
    ) {
      stripeAttempt += 1;
      pe = await this.prisma.paymentEvent.update({
        where: { id: pe.id },
        data: {
          status: PaymentEventStatus.PENDING,
          stripePaymentIntentId: null,
          metadata: { ...peMeta, stripeAttempt } as Prisma.InputJsonValue,
        },
      });
    }

    let pi;
    try {
      // Amount + attempt scoped so waiting accrual / failed PI retries do not reuse a stale PI.
      pi = await this.stripe.createPaymentIntent({
        amountCents: surcharge.amountIncGstCents,
        customerId,
        paymentMethodId,
        idempotencyKey: `${surcharge.idempotencyKey}:amt:${surcharge.amountIncGstCents}:att:${stripeAttempt}`,
        metadata: {
          paymentEventId: pe.id,
          surchargeId: surcharge.id,
          kind: surcharge.kind,
          tripId: surcharge.tripId,
          jobId: surcharge.jobId,
          paymentKind: 'SURCHARGE',
        },
      });
    } catch (err) {
      await this.prisma.paymentEvent.update({
        where: { id: pe.id },
        data: {
          status: PaymentEventStatus.FAILED,
          metadata: {
            ...((pe.metadata as Record<string, unknown>) ?? {}),
            stripeAttempt,
            error: err instanceof Error ? err.message : String(err),
          } as Prisma.InputJsonValue,
        },
      });
      throw new BadRequestException({
        message: 'Failed to create surcharge PaymentIntent',
        code: 'SURCHARGE_PI_FAILED',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const peStatus =
      pi.status === 'succeeded'
        ? PaymentEventStatus.SUCCEEDED
        : pi.status === 'requires_action'
          ? PaymentEventStatus.REQUIRES_ACTION
          : PaymentEventStatus.PENDING;

    await this.prisma.paymentEvent.update({
      where: { id: pe.id },
      data: {
        stripePaymentIntentId: pi.id,
        status: peStatus,
      },
    });

    if (pi.status === 'succeeded') {
      await this.markSurchargePaid({
        paymentEventId: pe.id,
        paymentIntentId: pi.id,
        source: pi.mock ? 'mock' : 'pi_immediate',
      });
    }

    const refreshed = await this.prisma.surcharge.findUnique({
      where: { id: surcharge.id },
      include: { paymentEvent: true },
    });
    return {
      ...this.mapSurcharge(refreshed!),
      clientSecret: pi.clientSecret,
      stripeStatus: pi.status,
      mock: pi.mock,
    };
  }

  async markSurchargePaid(params: {
    paymentEventId: string;
    paymentIntentId: string;
    source: string;
  }) {
    const pe = await this.prisma.paymentEvent.findUnique({
      where: { id: params.paymentEventId },
      include: { surcharge: true },
    });
    if (!pe?.surcharge) return { skipped: true as const };

    if (pe.surcharge.status === SurchargeStatus.PAID) {
      return { skipped: true as const, alreadyPaid: true as const };
    }

    // Waive wins over a late webhook — never flip WAIVED → PAID.
    if (pe.surcharge.status === SurchargeStatus.WAIVED) {
      if (params.paymentIntentId) {
        await this.stripe.cancelPaymentIntent(params.paymentIntentId).catch(() => undefined);
        // Late success after waive: refund stub so money is not kept.
        await this.stripe
          .createRefundStub({
            paymentIntentId: params.paymentIntentId,
            idempotencyKey: `refund:waived:${pe.surcharge.id}`,
          })
          .catch(() => undefined);
      }
      await this.audit.recordPlatform({
        action: AuditAction.SURCHARGE_PAID,
        entityType: 'Surcharge',
        entityId: pe.surcharge.id,
        metadata: {
          skipped: true,
          reason: 'already_waived',
          paymentIntentId: params.paymentIntentId,
          source: params.source,
        },
      });
      return { skipped: true as const, waived: true as const };
    }

    // Ignore stale PI success after a retry created a newer intent.
    if (
      pe.stripePaymentIntentId &&
      params.paymentIntentId &&
      pe.stripePaymentIntentId !== params.paymentIntentId
    ) {
      await this.audit.recordPlatform({
        action: AuditAction.SURCHARGE_PAID,
        entityType: 'Surcharge',
        entityId: pe.surcharge.id,
        metadata: {
          skipped: true,
          reason: 'stale_payment_intent',
          currentPi: pe.stripePaymentIntentId,
          webhookPi: params.paymentIntentId,
          source: params.source,
        },
      });
      return { skipped: true as const, stalePi: true as const };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.paymentEvent.update({
        where: { id: pe.id },
        data: {
          status: PaymentEventStatus.SUCCEEDED,
          stripePaymentIntentId: params.paymentIntentId,
        },
      });
      await tx.surcharge.update({
        where: { id: pe.surcharge!.id },
        data: {
          status: SurchargeStatus.PAID,
          paidAt: new Date(),
        },
      });
      if (pe.surcharge!.kind === SurchargeKind.MASS) {
        await tx.trip.update({
          where: { id: pe.surcharge!.tripId },
          data: {
            massCheckOk: true,
            massOverDeclared: false,
          },
        });
      }
    });

    await this.audit.recordPlatform({
      action: AuditAction.SURCHARGE_PAID,
      entityType: 'Surcharge',
      entityId: pe.surcharge.id,
      metadata: {
        paymentIntentId: params.paymentIntentId,
        source: params.source,
        kind: pe.surcharge.kind,
      },
    });

    return { skipped: false as const };
  }

  async listSenderSurcharges(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    if (principal.role === 'SUPER_ADMIN' && principal.kind === 'admin') {
      const rows = await this.prisma.surcharge.findMany({
        include: {
          paymentEvent: true,
          job: { select: { id: true, title: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return rows.map((s) => ({
        ...this.mapSurcharge(s),
        job: s.job,
        canWaive: s.status === SurchargeStatus.PENDING_PAYMENT,
      }));
    }
    if (principal.role !== 'SENDER') throw new ForbiddenException('Sender required');
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException();

    const rows = await this.prisma.surcharge.findMany({
      where: { job: { senderCompanyId: user.companyId } },
      include: {
        paymentEvent: true,
        job: { select: { id: true, title: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((s) => ({
      ...this.mapSurcharge(s),
      job: s.job,
    }));
  }

  async paySurcharge(principal: AuthenticatedPrincipal, surchargeId: string) {
    this.ensureDatabase();
    if (principal.role !== 'SENDER') throw new ForbiddenException('Sender required');
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { company: true },
    });
    if (!user?.companyId || !user.company) throw new NotFoundException();

    const surcharge = await this.prisma.surcharge.findFirst({
      where: { id: surchargeId, job: { senderCompanyId: user.companyId } },
    });
    if (!surcharge) throw new NotFoundException('Surcharge not found');
    if (surcharge.status !== SurchargeStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Surcharge is not pending payment');
    }

    return this.chargeSurcharge(surcharge.id, {
      customerId: user.company.stripeCustomerId!,
      paymentMethodId: user.company.stripeDefaultPaymentMethodId,
    });
  }

  async waiveSurcharge(principal: AuthenticatedPrincipal, surchargeId: string) {
    this.ensureDatabase();
    if (principal.kind !== 'admin' || principal.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Super Admin required');
    }
    const surcharge = await this.prisma.surcharge.findUnique({
      where: { id: surchargeId },
      include: { paymentEvent: true },
    });
    if (!surcharge) throw new NotFoundException('Surcharge not found');
    if (surcharge.status === SurchargeStatus.PAID) {
      throw new BadRequestException('Already paid');
    }
    if (surcharge.status === SurchargeStatus.WAIVED) {
      return this.mapSurcharge(surcharge);
    }

    const waived = await this.prisma.surcharge.updateMany({
      where: { id: surcharge.id, status: SurchargeStatus.PENDING_PAYMENT },
      data: {
        status: SurchargeStatus.WAIVED,
        waivedAt: new Date(),
        waivedByAdminId: principal.id,
      },
    });
    if (waived.count === 0) {
      const latest = await this.prisma.surcharge.findUnique({
        where: { id: surcharge.id },
        include: { paymentEvent: true },
      });
      if (latest?.status === SurchargeStatus.PAID) {
        throw new BadRequestException('Already paid');
      }
      return this.mapSurcharge(latest!);
    }

    if (surcharge.paymentEventId) {
      await this.prisma.paymentEvent.update({
        where: { id: surcharge.paymentEventId },
        data: { status: PaymentEventStatus.CANCELLED },
      });
    }
    if (surcharge.kind === SurchargeKind.MASS) {
      await this.prisma.trip.update({
        where: { id: surcharge.tripId },
        data: { massCheckOk: true, massOverDeclared: false },
      });
    }

    if (surcharge.paymentEvent?.stripePaymentIntentId) {
      await this.stripe.cancelPaymentIntent(surcharge.paymentEvent.stripePaymentIntentId);
    }

    await this.audit.recordPlatform({
      action: AuditAction.SURCHARGE_WAIVED,
      actorAdminId: principal.id,
      entityType: 'Surcharge',
      entityId: surcharge.id,
      metadata: { kind: surcharge.kind },
    });

    const refreshed = await this.prisma.surcharge.findUnique({
      where: { id: surcharge.id },
      include: { paymentEvent: true },
    });
    return this.mapSurcharge(refreshed!);
  }

  async listCarrierExceptions(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    if (principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier required');
    }
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException();

    const rows = await this.prisma.surcharge.findMany({
      where: {
        job: { assignment: { carrierCompanyId: user.companyId } },
        status: { in: [SurchargeStatus.PENDING_PAYMENT, SurchargeStatus.PAID] },
      },
      include: {
        job: { select: { id: true, title: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((s) => ({
      id: s.id,
      jobId: s.jobId,
      kind: s.kind,
      status: s.status,
      amountIncGstCents: s.amountIncGstCents,
      job: s.job,
      tripId: s.tripId,
      readOnly: true as const,
    }));
  }

  /**
   * Undo a failed accept so the sender can retry.
   * Deletes PENDING assignment + FAILED/orphan PE, restores proposal/job, un-expires conflict peers.
   */
  private async unwindFailedAccept(pe: {
    id: string;
    jobId: string | null;
    status: PaymentEventStatus;
    metadata: unknown;
    stripePaymentIntentId?: string | null;
  }) {
    if (!pe.jobId) {
      await this.prisma.paymentEvent.delete({ where: { id: pe.id } }).catch(() => undefined);
      return;
    }
    const meta = (pe.metadata ?? {}) as {
      proposalId?: string;
      assignmentId?: string;
      conflictIds?: string[];
    };
    const jobId = pe.jobId;

    await this.prisma.$transaction(async (tx) => {
      const assignment = meta.assignmentId
        ? await tx.assignment.findUnique({ where: { id: meta.assignmentId } })
        : await tx.assignment.findUnique({ where: { jobId } });

      const jobForPeers = await tx.job.findUnique({ where: { id: jobId } });
      const canRestorePeers =
        Boolean(assignment && assignment.status === AssignmentStatus.PENDING) &&
        Boolean(
          jobForPeers &&
            (jobForPeers.status === JobStatus.BIDDING ||
              jobForPeers.status === JobStatus.PUBLISHED ||
              jobForPeers.status === JobStatus.ASSIGNED),
        );

      if (assignment && assignment.status === AssignmentStatus.PENDING) {
        await tx.assignment.delete({ where: { id: assignment.id } });
      }

      if (meta.proposalId) {
        const proposal = await tx.proposal.findUnique({ where: { id: meta.proposalId } });
        if (proposal && proposal.status === ProposalStatus.ACCEPTED) {
          await tx.proposal.update({
            where: { id: proposal.id },
            data: { status: ProposalStatus.SUBMITTED },
          });
        }
      }

      if (meta.conflictIds?.length && canRestorePeers) {
        await tx.proposal.updateMany({
          where: {
            id: { in: meta.conflictIds },
            status: ProposalStatus.EXPIRED,
          },
          data: { status: ProposalStatus.SUBMITTED },
        });
      }

      const job = await tx.job.findUnique({ where: { id: jobId } });
      if (job && job.status === JobStatus.ASSIGNED) {
        const stillAssigned = await tx.assignment.findUnique({ where: { jobId } });
        if (!stillAssigned) {
          await tx.job.update({
            where: { id: jobId },
            data: { status: JobStatus.BIDDING },
          });
        }
      }

      await tx.paymentEvent.delete({ where: { id: pe.id } });
    });

    await this.audit.recordPlatform({
      action: AuditAction.PAYMENT_FAILED,
      entityType: 'PaymentEvent',
      entityId: pe.id,
      metadata: { unwound: true, jobId, reason: 'accept_pi_failed_rollback' },
    });
  }

  private buildAcceptResponse(
    paymentEvent: {
      id: string;
      status: PaymentEventStatus;
      amountIncGstCents: number;
      stripePaymentIntentId: string | null;
      jobId: string | null;
    },
    assignment: { id: string; status: AssignmentStatus; lockedAt: Date | null } | null,
    idempotentReplay: boolean,
  ) {
    return {
      paymentEventId: paymentEvent.id,
      paymentStatus: paymentEvent.status,
      amountIncGstCents: paymentEvent.amountIncGstCents,
      stripePaymentIntentId: paymentEvent.stripePaymentIntentId,
      jobId: paymentEvent.jobId,
      assignmentId: assignment?.id ?? null,
      assignmentStatus: assignment?.status ?? null,
      lockedAt: assignment?.lockedAt ?? null,
      paidAndConfirmed: assignment?.status === AssignmentStatus.LOCKED,
      idempotentReplay,
    };
  }

  async markPaidAndLock(params: {
    paymentEventId: string;
    paymentIntentId: string;
    source: string;
  }) {
    const pe = await this.prisma.paymentEvent.findUnique({
      where: { id: params.paymentEventId },
    });
    if (!pe?.jobId) return { skipped: true as const };

    if (pe.status === PaymentEventStatus.SUCCEEDED) {
      const assignment = await this.prisma.assignment.findUnique({
        where: { jobId: pe.jobId },
      });
      if (assignment?.status === AssignmentStatus.LOCKED) {
        await this.trips.ensureTripForAssignment(assignment.id);
        return { skipped: true as const, alreadyPaid: true as const };
      }
    }

    const meta = (pe.metadata ?? {}) as { assignmentId?: string };
    const assignmentId = meta.assignmentId;

    await this.prisma.$transaction(async (tx) => {
      await tx.paymentEvent.update({
        where: { id: pe.id },
        data: {
          status: PaymentEventStatus.SUCCEEDED,
          stripePaymentIntentId: params.paymentIntentId,
        },
      });

      if (assignmentId) {
        await tx.assignment.update({
          where: { id: assignmentId },
          data: {
            status: AssignmentStatus.LOCKED,
            lockedAt: new Date(),
          },
        });
      } else {
        await tx.assignment.updateMany({
          where: { jobId: pe.jobId! },
          data: { status: AssignmentStatus.LOCKED, lockedAt: new Date() },
        });
      }

      await tx.job.update({
        where: { id: pe.jobId! },
        data: { status: JobStatus.ASSIGNED },
      });

      // Ledger accrual stubs (disburse M10/M12)
      const existingLines = await tx.settlementLine.count({ where: { jobId: pe.jobId! } });
      if (existingLines === 0) {
        const gross = pe.amountIncGstCents;
        const carrier = Math.round(gross * 0.7);
        const superShare = Math.round(gross * 0.15);
        const stateShare = Math.round(gross * 0.1);
        const localShare = gross - carrier - superShare - stateShare;
        await tx.settlementLine.createMany({
          data: [
            {
              jobId: pe.jobId!,
              recipientType: SettlementRecipientType.CARRIER,
              sharePercent: 70,
              amountCents: carrier,
              status: SettlementLineStatus.ACCRUED,
            },
            {
              jobId: pe.jobId!,
              recipientType: SettlementRecipientType.SUPER_ADMIN,
              sharePercent: 15,
              amountCents: superShare,
              status: SettlementLineStatus.ACCRUED,
            },
            {
              jobId: pe.jobId!,
              recipientType: SettlementRecipientType.STATE_MASTER,
              sharePercent: 10,
              amountCents: stateShare,
              status: SettlementLineStatus.ACCRUED,
            },
            {
              jobId: pe.jobId!,
              recipientType: SettlementRecipientType.LOCAL_BDE,
              sharePercent: 5,
              amountCents: localShare,
              status: SettlementLineStatus.ACCRUED,
            },
          ],
        });
      }
    });

    await this.audit.recordPlatform({
      action: AuditAction.PAYMENT_SUCCEEDED,
      entityType: 'PaymentEvent',
      entityId: pe.id,
      metadata: { paymentIntentId: params.paymentIntentId, source: params.source },
    });
    await this.audit.recordPlatform({
      action: AuditAction.ASSIGNMENT_LOCKED,
      entityType: 'Job',
      entityId: pe.jobId,
      metadata: { paymentEventId: pe.id, source: params.source },
    });

    const locked = await this.prisma.assignment.findUnique({
      where: { jobId: pe.jobId },
    });
    if (locked) {
      await this.trips.ensureTripForAssignment(locked.id);
    }

    return { skipped: false as const };
  }

  async markPaymentFailed(params: {
    paymentEventId?: string;
    paymentIntentId: string;
  }) {
    const pe = params.paymentEventId
      ? await this.prisma.paymentEvent.findUnique({ where: { id: params.paymentEventId } })
      : await this.prisma.paymentEvent.findFirst({
          where: { stripePaymentIntentId: params.paymentIntentId },
        });
    if (!pe) return;

    // Never corrupt a successful charge or locked assignment.
    if (
      pe.status === PaymentEventStatus.SUCCEEDED ||
      pe.status === PaymentEventStatus.CANCELLED
    ) {
      return;
    }

    if (pe.jobId && pe.type === PaymentEventType.CHARGE) {
      const assignment = await this.prisma.assignment.findUnique({
        where: { jobId: pe.jobId },
      });
      if (assignment?.status === AssignmentStatus.LOCKED) {
        return;
      }
    }

    await this.prisma.paymentEvent.update({
      where: { id: pe.id },
      data: { status: PaymentEventStatus.FAILED },
    });
    await this.audit.recordPlatform({
      action: AuditAction.PAYMENT_FAILED,
      entityType: 'PaymentEvent',
      entityId: pe.id,
      metadata: { paymentIntentId: params.paymentIntentId },
    });

    // Accept CHARGE with PENDING assignment: unwind so retry works.
    if (pe.type === PaymentEventType.CHARGE && pe.jobId) {
      const assignment = await this.prisma.assignment.findUnique({
        where: { jobId: pe.jobId },
      });
      if (!assignment || assignment.status === AssignmentStatus.PENDING) {
        if (pe.stripePaymentIntentId) {
          await this.stripe.cancelPaymentIntent(pe.stripePaymentIntentId);
        }
        await this.unwindFailedAccept({
          ...pe,
          status: PaymentEventStatus.FAILED,
        });
      }
    }
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
    this.ensureDatabase();

    if (this.stripe.isMockMode()) {
      // Allow synthetic mock webhook for QA
      let parsed: { id?: string; type?: string; data?: { object?: { id?: string; metadata?: Record<string, string> } } };
      try {
        parsed = JSON.parse(rawBody.toString('utf8')) as typeof parsed;
      } catch {
        throw new BadRequestException('Invalid mock webhook JSON');
      }
      const eventId = parsed.id ?? `evt_mock_${Date.now()}`;
      const type = parsed.type ?? 'payment_intent.succeeded';
      const dup = await this.prisma.stripeWebhookEvent.findUnique({
        where: { stripeEventId: eventId },
      });
      if (dup) return { received: true, duplicate: true };

      const piId = parsed.data?.object?.id;
      const paymentEventId = parsed.data?.object?.metadata?.paymentEventId;
      // Process before recording so a thrown error lets Stripe/mock retry.
      if (type === 'payment_intent.succeeded' && piId) {
        if (paymentEventId) {
          await this.resolvePaymentIntentSucceeded({
            paymentEventId,
            paymentIntentId: piId,
            source: 'mock_webhook',
          });
        } else {
          const pe = await this.prisma.paymentEvent.findFirst({
            where: { stripePaymentIntentId: piId },
          });
          if (pe) {
            await this.resolvePaymentIntentSucceeded({
              paymentEventId: pe.id,
              paymentIntentId: piId,
              source: 'mock_webhook',
            });
          }
        }
      }
      if (type === 'payment_intent.payment_failed' && piId) {
        await this.markPaymentFailed({ paymentEventId, paymentIntentId: piId });
      }

      await this.prisma.stripeWebhookEvent.create({
        data: { stripeEventId: eventId, type, payload: parsed as object },
      });
      return { received: true, mock: true };
    }

    if (!signature) {
      throw new BadRequestException('Missing Stripe-Signature');
    }

    let event;
    try {
      event = this.stripe.constructWebhookEvent(rawBody, signature);
    } catch (err) {
      this.logger.warn(`Webhook signature failed: ${err instanceof Error ? err.message : err}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    const dup = await this.prisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    if (dup) return { received: true, duplicate: true };

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as {
        id: string;
        metadata?: Record<string, string>;
      };
      const paymentEventId = pi.metadata?.paymentEventId;
      if (paymentEventId) {
        await this.resolvePaymentIntentSucceeded({
          paymentEventId,
          paymentIntentId: pi.id,
          source: 'webhook',
        });
      } else {
        const pe = await this.prisma.paymentEvent.findFirst({
          where: { stripePaymentIntentId: pi.id },
        });
        if (pe) {
          await this.resolvePaymentIntentSucceeded({
            paymentEventId: pe.id,
            paymentIntentId: pi.id,
            source: 'webhook',
          });
        }
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as {
        id: string;
        metadata?: Record<string, string>;
      };
      await this.markPaymentFailed({
        paymentEventId: pi.metadata?.paymentEventId,
        paymentIntentId: pi.id,
      });
    }

    // Record only after successful processing so failures remain retryable.
    await this.prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        type: event.type,
        payload: event as unknown as object,
      },
    });

    return { received: true };
  }

  async getJobPaymentStatus(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new ForbiddenException();

    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        OR: [
          { senderCompanyId: user.companyId },
          { assignment: { carrierCompanyId: user.companyId } },
        ],
      },
      include: {
        assignment: true,
        paymentEvents: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });
    if (!job) throw new NotFoundException('Job not found');

    const charge = job.paymentEvents.find((e) => e.type === PaymentEventType.CHARGE);
    return {
      jobId: job.id,
      jobStatus: job.status,
      assignment: job.assignment
        ? {
            id: job.assignment.id,
            status: job.assignment.status,
            lockedAt: job.assignment.lockedAt,
            paidAndConfirmed: job.assignment.status === AssignmentStatus.LOCKED,
          }
        : null,
      payment: charge
        ? {
            id: charge.id,
            status: charge.status,
            amountIncGstCents: charge.amountIncGstCents,
            stripePaymentIntentId: charge.stripePaymentIntentId,
          }
        : null,
      canStartTrip: job.assignment?.status === AssignmentStatus.LOCKED,
    };
  }

  async listCarrierAssignments(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    if (principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier required');
    }
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException();

    const rows = await this.prisma.assignment.findMany({
      where: { carrierCompanyId: user.companyId },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            status: true,
            pricingModel: true,
            estimateIncGstCents: true,
          },
        },
        proposal: { select: { amountIncGstCents: true, etaMinutes: true } },
        trip: {
          include: {
            surcharges: {
              where: { status: SurchargeStatus.PENDING_PAYMENT },
              select: { id: true, kind: true, status: true, amountIncGstCents: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return rows.map((a) => ({
      id: a.id,
      status: a.status,
      lockedAt: a.lockedAt,
      paidAndConfirmed: a.status === AssignmentStatus.LOCKED,
      job: a.job,
      amountIncGstCents: a.proposal.amountIncGstCents,
      etaMinutes: a.proposal.etaMinutes,
      tripBlockedUntilPaid: a.status !== AssignmentStatus.LOCKED,
      exceptions: a.trip?.surcharges ?? [],
    }));
  }

  async refundStub(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    if (principal.role !== 'SENDER' && principal.kind !== 'admin') {
      throw new ForbiddenException();
    }

    let jobWhere: { id: string; senderCompanyId?: string } = { id: jobId };
    if (principal.kind === 'user') {
      const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
      if (!user?.companyId) throw new NotFoundException('Sender company not found');
      jobWhere = { id: jobId, senderCompanyId: user.companyId };
    }

    const job = await this.prisma.job.findFirst({ where: jobWhere });
    if (!job) {
      throw new NotFoundException('Job not found');
    }

    const pe = await this.prisma.paymentEvent.findFirst({
      where: {
        jobId,
        type: PaymentEventType.CHARGE,
        status: PaymentEventStatus.SUCCEEDED,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!pe?.stripePaymentIntentId) {
      throw new BadRequestException('No succeeded charge to refund');
    }
    const refund = await this.stripe.createRefundStub({
      paymentIntentId: pe.stripePaymentIntentId,
      idempotencyKey: `refund-stub:${jobId}:${pe.id}`,
    });
    await this.audit.recordPlatform({
      action: AuditAction.REFUND_STUB,
      actorUserId: principal.kind === 'user' ? principal.id : undefined,
      actorAdminId: principal.kind === 'admin' ? principal.id : undefined,
      entityType: 'PaymentEvent',
      entityId: pe.id,
      metadata: { refundId: refund.id, stub: true, fullPath: 'M10/M12' },
    });
    return {
      success: true,
      refundId: refund.id,
      message: 'Refund stub recorded — full cancel path is M10/M12',
      mock: refund.mock,
    };
  }
}
