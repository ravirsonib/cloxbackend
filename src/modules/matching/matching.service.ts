import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  DriverStatus,
  JobStatus,
  ProposalStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AuditAction, type ProposalSubmitInput } from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CarrierService } from '../carrier/carrier.service';
import { JobsService } from '../jobs/jobs.service';
import {
  carrierNetPayoutCents,
  gstSplitFromIncCents,
  isVehicleClassAdequate,
  licenceCoversVehicleClass,
} from '../jobs/job-pricing.util';

@Injectable()
export class MatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly carrierService: CarrierService,
    private readonly jobsService: JobsService,
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

  private carrierMatchesJob(
    company: {
      status: CompanyStatus;
      capabilities: string[];
      serviceRegionCodes: string[];
      homeRegion: { code: string } | null;
      vehicles: Array<{ vehicleClass: string | null; status: VehicleStatus }>;
    },
    job: {
      requiresDg: boolean;
      requiresReefer: boolean;
      requiresOversize: boolean;
      minVehicleClass: string | null;
      originRegion: { code: string } | null;
    },
  ) {
    if (job.requiresDg && !company.capabilities.includes('DG')) return false;
    if (job.requiresReefer && !company.capabilities.includes('REEFER')) return false;
    if (job.requiresOversize && !company.capabilities.includes('OVERSIZE')) return false;
    const regions = new Set([
      ...company.serviceRegionCodes,
      ...(company.homeRegion?.code ? [company.homeRegion.code] : []),
    ]);
    if (job.originRegion?.code && !regions.has(job.originRegion.code)) return false;
    const hasAdequateVehicle = company.vehicles.some(
      (v) =>
        v.status === VehicleStatus.ACTIVE &&
        isVehicleClassAdequate(v.vehicleClass, job.minVehicleClass),
    );
    return hasAdequateVehicle;
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
          where: { carrierCompanyId: company.id },
          take: 1,
        },
      },
      orderBy: { publishedAt: 'desc' },
      take: 50,
    });

    const visible = jobs.filter((j) => this.carrierMatchesJob(company, j));

    return {
      netPayoutHint: '70% of gross (platform share stub)',
      jobs: visible.map((j) => ({
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
        estimateNetToCarrierCents: j.estimateIncGstCents
          ? carrierNetPayoutCents(j.estimateIncGstCents)
          : null,
        pickupAt: j.pickupAt,
        publishedAt: j.publishedAt,
        alreadyBid: j.proposals.length > 0,
        stopsSummary: j.stops.map((s) => `${s.stopType}:${s.suburb ?? ''}`).join(' → '),
      })),
    };
  }

  async submitProposal(principal: AuthenticatedPrincipal, input: ProposalSubmitInput) {
    this.ensureDatabase();
    const eligibility = await this.carrierService.getBidEligibility(principal);
    if (!eligibility.canBid) {
      throw new ForbiddenException({
        message: 'Carrier cannot bid',
        code: 'CARRIER_NOT_BID_ELIGIBLE',
        goNoGo: eligibility.goNoGo,
      });
    }
    const user = await this.requireCarrierCompany(principal);
    const company = user.company!;
    const job = await this.jobsService.assertJobOpenForBidding(input.jobId);

    if (!this.carrierMatchesJob(company, job)) {
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
    if (!isVehicleClassAdequate(vehicle.vehicleClass, job.minVehicleClass)) {
      throw new BadRequestException({
        message: `Vehicle class ${vehicle.vehicleClass} undersized for min ${job.minVehicleClass}`,
        code: 'VEHICLE_CLASS_UNDERSIZE',
      });
    }

    const driver = await this.prisma.driver.findFirst({
      where: { id: input.driverId, companyId: company.id, status: DriverStatus.ACTIVE },
    });
    if (!driver) throw new BadRequestException('Active driver required');
    if (!driver.licenceExpiry || driver.licenceExpiry <= new Date()) {
      throw new BadRequestException({
        message: 'Driver licence expired or missing expiry',
        code: 'LICENCE_EXPIRED',
      });
    }
    if (!driver.nhvrAcknowledgedAt) {
      throw new BadRequestException({
        message: 'Driver NHVR acknowledgement required',
        code: 'NHVR_REQUIRED',
      });
    }
    if (!licenceCoversVehicleClass(driver.licenceClass, vehicle.vehicleClass)) {
      throw new BadRequestException({
        message: `Driver licence ${driver.licenceClass ?? 'none'} does not cover vehicle class ${vehicle.vehicleClass}`,
        code: 'LICENCE_CLASS_MISMATCH',
      });
    }

    const minBase = await this.jobsService.getMinBaseCents(
      job.pricingModel === 'HOURLY' ? 'HOURLY' : 'PER_KM',
    );
    if (input.amountIncGstCents < minBase) {
      throw new BadRequestException({
        message: `Bid below Super minimum base (${minBase} cents)`,
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
