import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  CompanyType,
  DriverStatus,
  JobStatus,
  NotificationType,
  PlatformRole,
  ProposalStatus,
  TripStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AuditAction, type ProposalSubmitInput } from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CarrierService } from '../carrier/carrier.service';
import { JobsService } from '../jobs/jobs.service';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertAssignmentCompliance } from '../jobs/assignment-gates';
import {
  carrierNetPayoutCents,
  gstSplitFromIncCents,
  isVehicleAdequateForJob,
  isVehicleClassAdequate,
} from '../jobs/job-pricing.util';
import { carrierMatchesJob } from './matching.eligibility';

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly carrierService: CarrierService,
    private readonly jobsService: JobsService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly inbox?: InAppNotificationsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private async requireCarrierCompany(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user' || principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: {
        company: {
          include: {
            vehicles: true,
            drivers: true,
            homeRegion: true,
          },
        },
      },
    });
    if (!user?.company || user.company.type !== CompanyType.CARRIER) {
      throw new NotFoundException('Carrier company not found');
    }
    return user;
  }

  async listBoard(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const eligibility = await this.carrierService.getBidEligibility(principal);
    if (!eligibility.canBid) {
      throw new ForbiddenException({
        message: 'Carrier cannot view job board until bid-eligible',
        code: 'CARRIER_NOT_BID_ELIGIBLE',
        goNoGo: eligibility.goNoGo,
      });
    }
    const user = await this.requireCarrierCompany(principal);
    const company = user.company!;

    const jobs = await this.prisma.job.findMany({
      where: { status: { in: [JobStatus.BIDDING, JobStatus.PUBLISHED] } },
      include: {
        stops: { orderBy: { sequence: 'asc' }, take: 4 },
        originRegion: true,
        proposals: {
          where: {
            carrierCompanyId: company.id,
            status: ProposalStatus.SUBMITTED,
          },
          take: 1,
        },
      },
      orderBy: [{ marketplacePriority: 'desc' }, { publishedAt: 'desc' }],
      take: 50,
    });

    const visible = jobs.filter((j) => carrierMatchesJob(company, j));

    return {
      netPayoutHint: '70% of gross to carrier (admin 30% pool is configurable)',
      jobs: visible.map((j) => {
        const discount = j.rescueDiscountPercent ?? 0;
        const discountedEstimate =
          j.estimateIncGstCents != null && discount > 0
            ? Math.floor((j.estimateIncGstCents * (100 - discount)) / 100)
            : j.estimateIncGstCents;
        return {
          id: j.id,
          title: j.title,
          status: j.status,
          pricingModel: j.pricingModel,
          minVehicleClass: j.minVehicleClass,
          requiresDg: j.requiresDg,
          requiresReefer: j.requiresReefer,
          requiresOversize: j.requiresOversize,
          chargeableWeightKg: j.chargeableWeightKg,
          routeDistanceKm: j.routeDistanceKm,
          routeDurationMinutes: j.routeDurationMinutes,
          routeFatigueBreakMinutes: j.routeFatigueBreakMinutes,
          billableHours: j.billableHours,
          estimateIncGstCents: j.estimateIncGstCents,
          estimateNetToCarrierCents: discountedEstimate
            ? carrierNetPayoutCents(discountedEstimate)
            : null,
          marketplacePriority: j.marketplacePriority,
          rescueDiscountPercent: j.rescueDiscountPercent,
          minBidIncGstCents: discountedEstimate,
          pickupAt: j.pickupAt,
          publishedAt: j.publishedAt,
          alreadyBid: j.proposals.length > 0,
          stopsSummary: j.stops.map((s) => `${s.stopType}:${s.suburb ?? ''}`).join(' → '),
        };
      }),
    };
  }

  async submitProposal(principal: AuthenticatedPrincipal, input: ProposalSubmitInput) {
    this.ensureDatabase();
    const eligibility = await this.carrierService.getBidEligibility(principal);
    if (!eligibility.canBid) {
      throw new ForbiddenException({
        message: eligibility.goNoGo.connectReady
          ? 'Carrier cannot bid'
          : 'Carrier cannot bid until Stripe payouts are ready. Open Carrier onboarding → Payouts.',
        code: 'CARRIER_NOT_BID_ELIGIBLE',
        goNoGo: eligibility.goNoGo,
        href: '/carrier/onboarding',
      });
    }
    const user = await this.requireCarrierCompany(principal);
    const company = user.company!;
    const job = await this.jobsService.assertJobOpenForBidding(input.jobId);

    if (!carrierMatchesJob(company, job)) {
      throw new ForbiddenException({
        message: 'Job not eligible for this carrier (region / DG / REEFER / OVERSIZE / vehicle class)',
        code: 'JOB_NOT_ELIGIBLE',
      });
    }

    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        id: input.vehicleId,
        companyId: company.id,
        status: VehicleStatus.ACTIVE,
      },
    });
    if (!vehicle) {
      throw new BadRequestException({
        message: 'Active vehicle required',
        code: 'VEHICLE_NOT_ACTIVE',
      });
    }
    if (
      !isVehicleAdequateForJob(
        vehicle.vehicleClass,
        job.minVehicleClass,
        job.chargeableWeightKg,
      )
    ) {
      throw new BadRequestException({
        message: `Vehicle class ${vehicle.vehicleClass} undersized for min ${job.minVehicleClass}`,
        code: 'VEHICLE_CLASS_UNDERSIZE',
      });
    }

    const driver = await this.prisma.driver.findFirst({
      where: { id: input.driverId, companyId: company.id, status: DriverStatus.ACTIVE },
    });
    if (!driver) throw new BadRequestException('Active driver required');
    await assertAssignmentCompliance(
      this.prisma,
      {
        driver,
        vehicleId: vehicle.id,
        vehicleClass: vehicle.vehicleClass,
      },
      'badRequest',
    );

    const vehicleBusyAssignment = await this.prisma.assignment.findFirst({
      where: {
        vehicleId: vehicle.id,
        OR: [
          { status: AssignmentStatus.PENDING },
          {
            status: AssignmentStatus.LOCKED,
            trip: {
              status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] },
            },
          },
        ],
      },
      select: { id: true, jobId: true, status: true },
    });
    if (vehicleBusyAssignment) {
      throw new ConflictException({
        message: 'Vehicle is already assigned or pending payment on another job',
        code: 'VEHICLE_BUSY',
        jobId: vehicleBusyAssignment.jobId,
      });
    }
    const driverBusyAssignment = await this.prisma.assignment.findFirst({
      where: {
        driverId: driver.id,
        OR: [
          { status: AssignmentStatus.PENDING },
          {
            status: AssignmentStatus.LOCKED,
            trip: {
              status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] },
            },
          },
        ],
      },
      select: { id: true, jobId: true, status: true },
    });
    if (driverBusyAssignment) {
      throw new ConflictException({
        message: 'Driver is already assigned or pending payment on another job',
        code: 'DRIVER_BUSY',
        jobId: driverBusyAssignment.jobId,
      });
    }

    const vehicleOpenBid = await this.prisma.proposal.findFirst({
      where: {
        vehicleId: vehicle.id,
        status: ProposalStatus.SUBMITTED,
        jobId: { not: job.id },
        job: { status: { in: [JobStatus.PUBLISHED, JobStatus.BIDDING] } },
      },
      select: { id: true, jobId: true },
    });
    if (vehicleOpenBid) {
      throw new ConflictException({
        message: 'Vehicle already has an open bid on another job — accept/withdraw that bid first',
        code: 'VEHICLE_BID_COMMITTED',
        jobId: vehicleOpenBid.jobId,
        proposalId: vehicleOpenBid.id,
      });
    }
    const driverOpenBid = await this.prisma.proposal.findFirst({
      where: {
        driverId: driver.id,
        status: ProposalStatus.SUBMITTED,
        jobId: { not: job.id },
        job: { status: { in: [JobStatus.PUBLISHED, JobStatus.BIDDING] } },
      },
      select: { id: true, jobId: true },
    });
    if (driverOpenBid) {
      throw new ConflictException({
        message: 'Driver already has an open bid on another job — accept/withdraw that bid first',
        code: 'DRIVER_BID_COMMITTED',
        jobId: driverOpenBid.jobId,
        proposalId: driverOpenBid.id,
      });
    }

    const policyMin = await this.jobsService.getMinBaseCents(
      job.pricingModel === 'HOURLY' ? 'HOURLY' : 'PER_KM',
    );
    const discount = job.rescueDiscountPercent ?? 0;
    let minBase = policyMin;
    if (discount > 0 && job.estimateIncGstCents != null) {
      // Rescue listing: carrier may bid down to discounted sender estimate.
      minBase = Math.floor((job.estimateIncGstCents * (100 - discount)) / 100);
    }
    if (input.amountIncGstCents < minBase) {
      throw new BadRequestException({
        message: `Bid below minimum (${minBase} cents)`,
        code: 'BID_BELOW_MIN_BASE',
        minBaseCents: minBase,
      });
    }

    const existing = await this.prisma.proposal.findFirst({
      where: {
        jobId: job.id,
        carrierCompanyId: company.id,
        status: ProposalStatus.SUBMITTED,
      },
    });
    if (existing) {
      throw new BadRequestException('Already submitted a proposal for this job');
    }

    const amounts = gstSplitFromIncCents(input.amountIncGstCents);
    const proposal = await this.prisma.proposal.create({
      data: {
        jobId: job.id,
        carrierCompanyId: company.id,
        vehicleId: vehicle.id,
        driverId: driver.id,
        etaMinutes: input.etaMinutes,
        status: ProposalStatus.SUBMITTED,
        ...amounts,
      },
    });

    if (job.status === JobStatus.PUBLISHED) {
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: JobStatus.BIDDING },
      });
    }

    await this.audit.recordPlatform({
      action: AuditAction.PROPOSAL_SUBMITTED,
      actorUserId: user.id,
      entityType: 'Proposal',
      entityId: proposal.id,
      metadata: { jobId: job.id, amountIncGstCents: input.amountIncGstCents },
    });

    try {
      const jobNotify = await this.prisma.job.findUnique({
        where: { id: job.id },
        select: {
          id: true,
          title: true,
          senderCompany: {
            select: {
              email: true,
              users: {
                where: { role: PlatformRole.SENDER },
                select: { id: true, email: true },
                take: 10,
              },
            },
          },
        },
      });
      const jobLabel = jobNotify?.title || job.id.slice(0, 8);
      const senderUserIds =
        jobNotify?.senderCompany?.users.map((u) => u.id).filter(Boolean) ?? [];
      if (this.inbox && senderUserIds.length > 0) {
        void this.inbox.notifyUsers({
          userIds: senderUserIds,
          type: NotificationType.BID_RECEIVED,
          title: `New bid on ${jobLabel}`,
          body: `A carrier bid $${(proposal.amountIncGstCents / 100).toFixed(2)} incl. GST.`,
          href: `/jobs/${job.id}`,
          entityType: 'Proposal',
          entityId: proposal.id,
        });
      }
      if (this.notifications) {
        const senderEmails = [
          ...(jobNotify?.senderCompany?.users.map((u) => u.email) ?? []),
          ...(jobNotify?.senderCompany?.email
            ? [jobNotify.senderCompany.email]
            : []),
        ];
        if (senderEmails.length > 0) {
          await this.notifications.notifyProposalSubmitted({
            senderEmails,
            jobId: job.id,
            jobTitle: jobNotify?.title ?? '',
            amountIncGstCents: proposal.amountIncGstCents,
            etaMinutes: proposal.etaMinutes,
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `Bid notify failed for proposal ${proposal.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return {
      id: proposal.id,
      jobId: job.id,
      status: proposal.status,
      amountIncGstCents: proposal.amountIncGstCents,
      netToCarrierCents: carrierNetPayoutCents(proposal.amountIncGstCents),
      etaMinutes: proposal.etaMinutes,
      vehicleId: proposal.vehicleId,
      driverId: proposal.driverId,
    };
  }
}
