import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AuditAction,
  LeadType,
  type AdminAuditQuery,
  type AdminCompanyListQuery,
  type AdminDashboardQuery,
  type AdminJobListQuery,
  type AdminLeadExportQuery,
  type AdminLeadListQuery,
  type CreateLeadNoteInput,
  type DisableCompanyInput,
  type PlatformSettingsPatchInput,
  type UpdateLeadInput,
  type VehicleClassCreateInput,
  type VehicleClassDto,
  type VehicleClassUpdateInput,
} from '../../shared/types';
import { DEFAULT_VEHICLE_CLASSES } from '../jobs/job-pricing.util';
import {
  AdminUserStatus,
  AssignmentStatus,
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  DriverStatus,
  JobStatus,
  Prisma,
  ProposalStatus,
  TripExceptionKind,
  TripExceptionStatus,
  TripStatus,
  UserStatus,
  VehicleStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

const leadListSelect = {
  id: true,
  type: true,
  status: true,
  email: true,
  phone: true,
  companyName: true,
  abn: true,
  state: true,
  territory: true,
  priority: true,
  assigneeId: true,
  locale: true,
  source: true,
  createdAt: true,
  updatedAt: true,
  assignee: {
    select: { id: true, email: true, name: true },
  },
} satisfies Prisma.LeadSelect;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private buildLeadWhere(query: {
    type?: AdminLeadListQuery['type'];
    status?: AdminLeadListQuery['status'];
    q?: string;
    priority?: boolean;
    from?: string;
    to?: string;
  }): Prisma.LeadWhereInput {
    const where: Prisma.LeadWhereInput = {};

    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.priority !== undefined) where.priority = query.priority;

    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.q) {
      where.OR = [
        { email: { contains: query.q, mode: 'insensitive' } },
        { companyName: { contains: query.q, mode: 'insensitive' } },
        { phone: { contains: query.q, mode: 'insensitive' } },
        { abn: { contains: query.q.replace(/\s+/g, ''), mode: 'insensitive' } },
        { state: { contains: query.q, mode: 'insensitive' } },
        { territory: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  async getDashboardStats(query?: AdminDashboardQuery) {
    this.ensureDatabase();

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - 6);

    // Determine filter range
    let startDate: Date | undefined;
    let endDate: Date = now;
    const period = query?.period ?? (query?.from ? 'custom' : '30d');

    if (query?.from) {
      startDate = new Date(query.from);
      if (query?.to) {
        endDate = new Date(query.to);
      }
    } else if (period === 'today') {
      startDate = startOfToday;
    } else if (period === 'week') {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
    } else if (period === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (period === '30d') {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 30);
    } else if (period === 'year') {
      startDate = new Date(now.getFullYear(), 0, 1);
    } else if (period === 'all') {
      startDate = undefined;
    } else {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 30);
    }

    const inDateRange = startDate ? { gte: startDate, lte: endDate } : undefined;
    const createdAtFilter = inDateRange ? { createdAt: inDateRange } : {};
    const openedAtFilter = inDateRange ? { openedAt: inDateRange } : {};

    const [
      // Phase 0 compatibility
      totalLeads,
      todayLeads,
      weekLeads,
      byType,
      byStatus,
      recentLeads,
      recentEvents,

      // 1. Senders
      totalSenders,
      activeSenders,
      pendingSenders,
      newSendersInPeriod,

      // 2. Carriers
      totalCarriers,
      activeCarriers,
      pendingCarriers,
      newCarriersInPeriod,

      // 3. Trucks / Vehicles
      totalTrucks,
      activeTrucks,
      pendingTrucks,
      newTrucksInPeriod,
      trucksByClassRaw,
      inTransitTrucksCount,

      // 4. Drivers
      totalDrivers,
      activeDrivers,
      pendingDrivers,
      newDriversInPeriod,
      onTripDriversCount,

      // 5. Receivers & Jobs
      totalJobs,
      jobsInPeriod,
      jobsByStatusRaw,
      jobsAggregate,
      recentJobs,
      recentReceiversRaw,

      // 6. Trips
      totalTrips,
      tripsInPeriod,
      activeTrips,
      completedTrips,
      breakdownTrips,

      // 7. Breakdowns / Trip Exceptions
      totalExceptions,
      exceptionsInPeriod,
      openExceptions,
      resolvedExceptions,
      exceptionsByKindRaw,
      recentExceptionsRaw,

      // 8. Timeline series sources
      timelineJobsRaw,
      timelineTripsRaw,
      timelineExceptionsRaw,
      timelineCompaniesRaw,
    ] = await Promise.all([
      // Leads
      this.prisma.lead.count(),
      this.prisma.lead.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.lead.count({ where: { createdAt: { gte: startOfWeek } } }),
      this.prisma.lead.groupBy({ by: ['type'], _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.lead.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: leadListSelect,
      }),
      this.prisma.leadEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          actor: { select: { id: true, email: true, name: true } },
          lead: { select: { id: true, type: true, email: true, companyName: true } },
        },
      }),

      // Senders
      this.prisma.company.count({ where: { type: CompanyType.SENDER } }),
      this.prisma.company.count({ where: { type: CompanyType.SENDER, status: CompanyStatus.ACTIVE } }),
      this.prisma.company.count({ where: { type: CompanyType.SENDER, status: CompanyStatus.PENDING_REVIEW } }),
      this.prisma.company.count({ where: { type: CompanyType.SENDER, ...createdAtFilter } }),

      // Carriers
      this.prisma.company.count({ where: { type: CompanyType.CARRIER } }),
      this.prisma.company.count({ where: { type: CompanyType.CARRIER, status: CompanyStatus.ACTIVE } }),
      this.prisma.company.count({ where: { type: CompanyType.CARRIER, status: CompanyStatus.PENDING_REVIEW } }),
      this.prisma.company.count({ where: { type: CompanyType.CARRIER, ...createdAtFilter } }),

      // Trucks
      this.prisma.vehicle.count(),
      this.prisma.vehicle.count({ where: { status: VehicleStatus.ACTIVE } }),
      this.prisma.vehicle.count({ where: { status: VehicleStatus.PENDING_REVIEW } }),
      this.prisma.vehicle.count({ where: createdAtFilter }),
      this.prisma.vehicle.groupBy({ by: ['vehicleClass'], _count: { _all: true } }),
      this.prisma.trip.count({
        where: {
          status: { in: [TripStatus.EN_ROUTE_PICKUP, TripStatus.AT_PICKUP, TripStatus.IN_TRANSIT, TripStatus.AT_DROPOFF] },
          assignment: { vehicleId: { not: null } },
        },
      }),

      // Drivers
      this.prisma.driver.count(),
      this.prisma.driver.count({ where: { status: DriverStatus.ACTIVE } }),
      this.prisma.driver.count({ where: { status: DriverStatus.PENDING_REVIEW } }),
      this.prisma.driver.count({ where: createdAtFilter }),
      this.prisma.trip.count({
        where: {
          status: { in: [TripStatus.EN_ROUTE_PICKUP, TripStatus.AT_PICKUP, TripStatus.IN_TRANSIT, TripStatus.AT_DROPOFF] },
          assignment: { driverId: { not: null } },
        },
      }),

      // Jobs
      this.prisma.job.count(),
      this.prisma.job.count({ where: createdAtFilter }),
      this.prisma.job.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.job.aggregate({
        _sum: { estimateIncGstCents: true },
        where: createdAtFilter,
      }),
      this.prisma.job.findMany({
        take: 6,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          status: true,
          pricingModel: true,
          estimateIncGstCents: true,
          receiverName: true,
          createdAt: true,
          senderCompany: { select: { id: true, legalName: true, tradingName: true } },
        },
      }),
      this.prisma.job.findMany({
        where: { receiverName: { not: null } },
        select: { receiverName: true, receiverEmail: true, receiverPhone: true, title: true },
        take: 10,
        orderBy: { createdAt: 'desc' },
      }),

      // Trips
      this.prisma.trip.count(),
      this.prisma.trip.count({ where: createdAtFilter }),
      this.prisma.trip.count({
        where: {
          status: { in: [TripStatus.EN_ROUTE_PICKUP, TripStatus.AT_PICKUP, TripStatus.IN_TRANSIT, TripStatus.AT_DROPOFF] },
        },
      }),
      this.prisma.trip.count({ where: { status: TripStatus.COMPLETED } }),
      this.prisma.trip.count({ where: { status: TripStatus.BREAKDOWN } }),

      // Exceptions & Breakdowns
      this.prisma.tripException.count(),
      this.prisma.tripException.count({ where: openedAtFilter }),
      this.prisma.tripException.count({
        where: {
          status: {
            in: [
              TripExceptionStatus.OPEN,
              TripExceptionStatus.AWAITING_CARRIER,
              TripExceptionStatus.REASSIGN_IN_PROGRESS,
              TripExceptionStatus.AWAITING_SENDER_APPROVAL,
              TripExceptionStatus.ESCALATED,
            ],
          },
        },
      }),
      this.prisma.tripException.count({
        where: {
          status: {
            in: [
              TripExceptionStatus.RESOLVED_REASSIGNED,
              TripExceptionStatus.RESOLVED_CONTINUED,
              TripExceptionStatus.RESOLVED_CANCELLED,
              TripExceptionStatus.RESOLVED_RELISTED,
              TripExceptionStatus.CLOSED,
            ],
          },
        },
      }),
      this.prisma.tripException.groupBy({ by: ['kind'], _count: { _all: true } }),
      this.prisma.tripException.findMany({
        take: 6,
        orderBy: { openedAt: 'desc' },
        select: {
          id: true,
          tripId: true,
          kind: true,
          status: true,
          note: true,
          openedAt: true,
          company: { select: { id: true, legalName: true, tradingName: true } },
        },
      }),

      // Timeline sources
      this.prisma.job.findMany({
        where: inDateRange ? { createdAt: inDateRange } : { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } },
        select: { createdAt: true, estimateIncGstCents: true },
        take: 2000,
      }),
      this.prisma.trip.findMany({
        where: inDateRange ? { createdAt: inDateRange } : { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } },
        select: { createdAt: true },
        take: 2000,
      }),
      this.prisma.tripException.findMany({
        where: inDateRange ? { openedAt: inDateRange } : { openedAt: { gte: new Date(Date.now() - 30 * 86400000) } },
        select: { openedAt: true },
        take: 2000,
      }),
      this.prisma.company.findMany({
        where: inDateRange ? { createdAt: inDateRange } : { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } },
        select: { type: true, createdAt: true },
        take: 2000,
      }),
    ]);

    const typeCounts = Object.fromEntries(
      byType.map((row) => [row.type, row._count._all]),
    ) as Partial<Record<LeadType, number>>;

    // Timeline bucket generation
    const effectiveStart = startDate ?? new Date(now.getTime() - 30 * 86400000);
    const totalMs = Math.max(86400000, endDate.getTime() - effectiveStart.getTime());
    const bucketCount = period === 'today' ? 6 : period === 'week' ? 7 : 8;
    const bucketDurationMs = totalMs / bucketCount;

    const timeline = Array.from({ length: bucketCount }, (_, idx) => {
      const bStart = new Date(effectiveStart.getTime() + idx * bucketDurationMs);
      const bEnd = new Date(effectiveStart.getTime() + (idx + 1) * bucketDurationMs);

      const label =
        period === 'today'
          ? `${bStart.getHours()}:00`
          : period === 'week'
          ? bStart.toLocaleDateString('en-AU', { weekday: 'short' })
          : bStart.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' });

      let jobs = 0;
      let volumeCents = 0;
      for (const j of timelineJobsRaw) {
        if (j.createdAt >= bStart && j.createdAt < bEnd) {
          jobs++;
          volumeCents += j.estimateIncGstCents ?? 0;
        }
      }

      let trips = 0;
      for (const t of timelineTripsRaw) {
        if (t.createdAt >= bStart && t.createdAt < bEnd) trips++;
      }

      let exceptions = 0;
      for (const e of timelineExceptionsRaw) {
        if (e.openedAt >= bStart && e.openedAt < bEnd) exceptions++;
      }

      let senders = 0;
      let carriers = 0;
      for (const c of timelineCompaniesRaw) {
        if (c.createdAt >= bStart && c.createdAt < bEnd) {
          if (c.type === CompanyType.SENDER) senders++;
          else if (c.type === CompanyType.CARRIER) carriers++;
        }
      }

      return {
        date: bStart.toISOString(),
        label,
        jobs,
        trips,
        exceptions,
        senders,
        carriers,
        volumeCents,
      };
    });

    const exceptionsByKind = {
      breakdown: 0,
      accident: 0,
      traffic: 0,
      driverUnavailable: 0,
      other: 0,
    };
    for (const row of exceptionsByKindRaw) {
      if (row.kind === TripExceptionKind.VEHICLE_BREAKDOWN) exceptionsByKind.breakdown = row._count._all;
      else if (row.kind === TripExceptionKind.ACCIDENT) exceptionsByKind.accident = row._count._all;
      else if (row.kind === TripExceptionKind.TRAFFIC) exceptionsByKind.traffic = row._count._all;
      else if (row.kind === TripExceptionKind.DRIVER_UNAVAILABLE) exceptionsByKind.driverUnavailable = row._count._all;
      else exceptionsByKind.other += row._count._all;
    }

    const jobsByStatus: Record<string, number> = {};
    for (const row of jobsByStatusRaw) {
      jobsByStatus[row.status] = row._count._all;
    }

    const trucksByClass: Record<string, number> = {};
    for (const row of trucksByClassRaw) {
      if (row.vehicleClass) trucksByClass[row.vehicleClass] = row._count._all;
    }

    const uniqueReceiversSet = new Set<string>();
    const recentReceivers: Array<{ name: string | null; email: string | null; phone: string | null; jobTitle?: string | null }> = [];
    for (const r of recentReceiversRaw) {
      const key = r.receiverEmail || r.receiverName || '';
      if (key && !uniqueReceiversSet.has(key)) {
        uniqueReceiversSet.add(key);
        recentReceivers.push({
          name: r.receiverName,
          email: r.receiverEmail,
          phone: r.receiverPhone,
          jobTitle: r.title,
        });
      }
    }

    return {
      period,
      from: startDate?.toISOString(),
      to: endDate.toISOString(),

      // Backward-compatibility
      totals: {
        all: totalLeads,
        today: todayLeads,
        week: weekLeads,
        registrySenders: typeCounts.REGISTRY_SENDER ?? 0,
        registryCarriers: typeCounts.REGISTRY_CARRIER ?? 0,
        eoiStateMasters: typeCounts.EOI_STATE_MASTER ?? 0,
        eoiLocalBdes: typeCounts.EOI_LOCAL_BDE ?? 0,
        investors: typeCounts.INVESTOR ?? 0,
      },
      byStatus: Object.fromEntries(
        byStatus.map((row) => [row.status, row._count._all]),
      ),
      recentLeads,
      recentActivity: recentEvents,

      // Rich Marketplace Analytics
      analytics: {
        senders: {
          total: totalSenders,
          active: activeSenders,
          pending: pendingSenders,
          inPeriod: newSendersInPeriod,
        },
        carriers: {
          total: totalCarriers,
          active: activeCarriers,
          pending: pendingCarriers,
          inPeriod: newCarriersInPeriod,
        },
        trucks: {
          total: totalTrucks,
          active: activeTrucks,
          inTransit: inTransitTrucksCount,
          pending: pendingTrucks,
          inPeriod: newTrucksInPeriod,
          byClass: trucksByClass,
        },
        drivers: {
          total: totalDrivers,
          active: activeDrivers,
          onTrip: onTripDriversCount,
          pending: pendingDrivers,
          inPeriod: newDriversInPeriod,
        },
        receivers: {
          total: uniqueReceiversSet.size,
          inPeriod: recentReceivers.length,
          recent: recentReceivers,
        },
        breakdowns: {
          total: totalExceptions,
          inPeriod: exceptionsInPeriod,
          open: openExceptions,
          resolved: resolvedExceptions,
          byKind: exceptionsByKind,
          recent: recentExceptionsRaw.map((e) => ({
            id: e.id,
            tripId: e.tripId ?? '',
            kind: e.kind,
            status: e.status,
            createdAt: e.openedAt.toISOString(),
            note: e.note,
            companyName: e.company?.tradingName || e.company?.legalName || 'Unknown Carrier',
          })),
        },
        jobs: {
          total: totalJobs,
          inPeriod: jobsInPeriod,
          active: (jobsByStatus[JobStatus.PUBLISHED] ?? 0) + (jobsByStatus[JobStatus.BIDDING] ?? 0),
          assigned: jobsByStatus[JobStatus.ASSIGNED] ?? 0,
          inTransit: jobsByStatus[JobStatus.IN_TRANSIT] ?? 0,
          completed: jobsByStatus[JobStatus.COMPLETED] ?? 0,
          cancelled: jobsByStatus[JobStatus.CANCELLED] ?? 0,
          draft: jobsByStatus[JobStatus.DRAFT] ?? 0,
          totalEstimateCents: jobsAggregate._sum.estimateIncGstCents ?? 0,
          recent: recentJobs.map((j) => ({
            id: j.id,
            title: j.title || 'General Freight',
            status: j.status,
            pricingModel: j.pricingModel,
            estimateIncGstCents: j.estimateIncGstCents ?? 0,
            receiverName: j.receiverName,
            createdAt: j.createdAt.toISOString(),
            companyName: j.senderCompany?.tradingName || j.senderCompany?.legalName || 'Unknown Sender',
          })),
        },
        trips: {
          total: totalTrips,
          inPeriod: tripsInPeriod,
          active: activeTrips,
          completed: completedTrips,
          cancelled: 0,
          breakdown: breakdownTrips,
        },
        timeline,
      },
    };
  }

  async listLeads(query: AdminLeadListQuery) {
    this.ensureDatabase();

    const where = this.buildLeadWhere(query);
    const skip = (query.page - 1) * query.pageSize;

    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: query.pageSize,
        select: leadListSelect,
      }),
      this.prisma.lead.count({ where }),
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /**
   * Get full company details including company docs, fleet with vehicle docs, and drivers with driver docs.
   */
  async getCompany(id: string) {
    this.ensureDatabase();

    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        homeRegion: { select: { code: true, name: true } },
        referredByAdminUser: {
          select: { id: true, name: true, email: true, role: true },
        },
        users: {
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            role: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
        complianceDocuments: {
          where: {
            driverId: null,
            vehicleId: null,
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            docType: true,
            status: true,
            originalFilename: true,
            mimeType: true,
            sizeBytes: true,
            expiresAt: true,
            reviewedAt: true,
            reviewNote: true,
            createdAt: true,
          },
        },
        vehicles: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            label: true,
            registration: true,
            vehicleClass: true,
            tareKg: true,
            gvmKg: true,
            gcmKg: true,
            status: true,
            disabledAt: true,
            disabledReason: true,
            disabledNote: true,
            createdAt: true,
            complianceDocuments: {
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                docType: true,
                status: true,
                originalFilename: true,
                mimeType: true,
                sizeBytes: true,
                expiresAt: true,
                reviewedAt: true,
                reviewNote: true,
                createdAt: true,
              },
            },
          },
        },
        drivers: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            licenceNo: true,
            licenceClass: true,
            licenceExpiry: true,
            reliabilityScore: true,
            disabledAt: true,
            disabledReason: true,
            disabledNote: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                phone: true,
                status: true,
              },
            },
            complianceDocuments: {
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                docType: true,
                status: true,
                originalFilename: true,
                mimeType: true,
                sizeBytes: true,
                expiresAt: true,
                reviewedAt: true,
                reviewNote: true,
                createdAt: true,
              },
            },
          },
        },
        complianceCases: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            caseType: true,
            status: true,
            decisionNote: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    const {
      complianceDocuments,
      vehicles,
      drivers,
      users,
      complianceCases,
      ...companyDetails
    } = company;

    return {
      company: companyDetails,
      documents: complianceDocuments,
      vehicles: vehicles.map((v) => ({
        ...v,
        documents: v.complianceDocuments,
      })),
      drivers: drivers.map((d) => ({
        ...d,
        documents: d.complianceDocuments,
      })),
      users,
      complianceCases,
    };
  }

  async listCompanies(query: AdminCompanyListQuery) {
    this.ensureDatabase();

    const where: Prisma.CompanyWhereInput = {};
    // Marketplace companies only â€” admin partners live under Ops â†’ Admin partners.
    where.type = query.type
      ? query.type
      : { in: [CompanyType.SENDER, CompanyType.CARRIER] };
    if (query.status) where.status = query.status;
    if (query.regionCode) {
      where.homeRegion = { code: query.regionCode.toUpperCase() };
    }
    if (query.q) {
      const q = query.q;
      const abnQ = q.replace(/\s+/g, '');
      where.OR = [
        { legalName: { contains: q, mode: 'insensitive' } },
        { tradingName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        ...(abnQ ? [{ abn: { contains: abnQ, mode: 'insensitive' as const } }] : []),
      ];
    }

    const skip = (query.page - 1) * query.pageSize;
    const openCaseStatuses: ComplianceCaseStatus[] = [
      ComplianceCaseStatus.OPEN,
      ComplianceCaseStatus.INFO_REQUESTED,
      ComplianceCaseStatus.ESCALATED,
    ];

    const [rows, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          legalName: true,
          tradingName: true,
          abn: true,
          email: true,
          phone: true,
          suspendedAt: true,
          suspendedReason: true,
          suspendedNote: true,
          statusBeforeSuspend: true,
          reliabilityScore: true,
          createdAt: true,
          updatedAt: true,
          homeRegion: { select: { code: true, name: true } },
          complianceCases: {
            where: { status: { in: openCaseStatuses } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, status: true, caseType: true },
          },
          _count: {
            select: {
              users: true,
              vehicles: true,
              drivers: true,
            },
          },
        },
      }),
      this.prisma.company.count({ where }),
    ]);

    const items = rows.map((row) => {
      const { complianceCases, _count, ...company } = row;
      return {
        ...company,
        openCase: complianceCases[0] ?? null,
        counts: {
          users: _count.users,
          vehicles: _count.vehicles,
          drivers: _count.drivers,
        },
      };
    });

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /**
   * Soft-disable company (SUSPENDED) with required reason.
   * Cascades users â†’ SUSPENDED, drivers â†’ SUSPENDED, active vehicles â†’ SUSPENDED,
   * revokes sessions, and emails account holders.
   */
  async disableCompany(id: string, input: DisableCompanyInput, actorId: string) {
    this.ensureDatabase();

    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        users: { select: { id: true, email: true, status: true } },
        adminUsers: { select: { id: true, email: true } },
      },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    if (company.status === CompanyStatus.SUSPENDED) {
      throw new BadRequestException('Company is already suspended');
    }
    if (company.status === CompanyStatus.DRAFT) {
      throw new BadRequestException(
        'Draft companies cannot be suspended â€” use permanent delete instead',
      );
    }

    const reason = input.reason.trim();
    const note = input.note?.trim() || null;
    const now = new Date();
    const partnerAdminIds = (company.adminUsers ?? []).map((a) => a.id);

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.company.update({
        where: { id },
        data: {
          statusBeforeSuspend: company.status,
          status: CompanyStatus.SUSPENDED,
          suspendedAt: now,
          suspendedReason: reason,
          suspendedNote: note,
        },
      });

      const userIds = company.users.map((u) => u.id);

      const usersSuspended = await tx.user.updateMany({
        where: {
          companyId: id,
          status: { in: [UserStatus.ACTIVE, UserStatus.PENDING] },
        },
        data: { status: UserStatus.SUSPENDED },
      });

      const driversSuspended = await tx.driver.updateMany({
        where: {
          OR: [{ companyId: id }, ...(userIds.length ? [{ userId: { in: userIds } }] : [])],
          status: { in: [DriverStatus.ACTIVE, DriverStatus.PENDING_REVIEW] },
        },
        data: { status: DriverStatus.SUSPENDED },
      });

      const vehiclesSuspended = await tx.vehicle.updateMany({
        where: {
          companyId: id,
          status: { in: [VehicleStatus.ACTIVE, VehicleStatus.PENDING_REVIEW] },
        },
        data: { status: VehicleStatus.SUSPENDED },
      });

      if (partnerAdminIds.length) {
        await tx.adminUser.updateMany({
          where: { id: { in: partnerAdminIds } },
          data: { status: AdminUserStatus.SUSPENDED, active: false },
        });
      }

      let sessionsRevoked = 0;
      if (userIds.length) {
        const revoked = await tx.authSession.updateMany({
          where: { userId: { in: userIds }, revokedAt: null },
          data: { revokedAt: now },
        });
        sessionsRevoked += revoked.count;
      }
      if (partnerAdminIds.length) {
        const revoked = await tx.authSession.updateMany({
          where: { adminUserId: { in: partnerAdminIds }, revokedAt: null },
          data: { revokedAt: now },
        });
        sessionsRevoked += revoked.count;
      }

      return {
        company: updated,
        usersSuspended: usersSuspended.count,
        driversSuspended: driversSuspended.count,
        vehiclesSuspended: vehiclesSuspended.count,
        sessionsRevoked,
      };
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_SUSPENDED,
      actorAdminId: actorId,
      entityType: 'Company',
      entityId: id,
      metadata: {
        reason,
        note,
        previousStatus: company.status,
        companyType: company.type,
        usersSuspended: result.usersSuspended,
        driversSuspended: result.driversSuspended,
        vehiclesSuspended: result.vehiclesSuspended,
        sessionsRevoked: result.sessionsRevoked,
        partnerAdminsSuspended: partnerAdminIds.length,
      },
    });

    const notifyEmails = new Set<string>();
    if (company.email?.trim()) notifyEmails.add(company.email.trim().toLowerCase());
    for (const user of company.users) {
      if (user.email?.trim()) notifyEmails.add(user.email.trim().toLowerCase());
    }
    for (const partner of company.adminUsers ?? []) {
      if (partner.email?.trim()) notifyEmails.add(partner.email.trim().toLowerCase());
    }

    const notifyType =
      company.type === CompanyType.CARRIER
        ? ('CARRIER' as const)
        : company.type === CompanyType.ADMIN_PARTNER
          ? ('ADMIN_PARTNER' as const)
          : ('SENDER' as const);

    await Promise.all(
      [...notifyEmails].map((to) =>
        this.notifications.sendAccountSuspendedEmail({
          to,
          companyName: company.tradingName || company.legalName,
          companyType: notifyType,
          reason,
          note,
        }),
      ),
    );

    return {
      id: result.company.id,
      status: result.company.status,
      statusBeforeSuspend: result.company.statusBeforeSuspend,
      suspendedAt: result.company.suspendedAt,
      suspendedReason: result.company.suspendedReason,
      suspendedNote: result.company.suspendedNote,
      cascade: {
        usersSuspended: result.usersSuspended,
        driversSuspended: result.driversSuspended,
        vehiclesSuspended: result.vehiclesSuspended,
        sessionsRevoked: result.sessionsRevoked,
      },
    };
  }

  async reactivateCompany(id: string, actorId: string) {
    this.ensureDatabase();

    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        users: { select: { id: true } },
        adminUsers: { select: { id: true } },
      },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    if (company.status !== CompanyStatus.SUSPENDED) {
      throw new BadRequestException('Company is not suspended');
    }

    const restoreStatus = company.statusBeforeSuspend ?? CompanyStatus.PENDING_REVIEW;
    const userIds = company.users.map((u) => u.id);
    const partnerAdminIds = (company.adminUsers ?? []).map((a) => a.id);

    const partnerRestore =
      restoreStatus === CompanyStatus.ACTIVE
        ? { status: AdminUserStatus.ACTIVE, active: true }
        : restoreStatus === CompanyStatus.PENDING_REVIEW
          ? { status: AdminUserStatus.PENDING_REVIEW, active: false }
          : { status: AdminUserStatus.PENDING_DOCS, active: false };

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.company.update({
        where: { id },
        data: {
          status: restoreStatus,
          statusBeforeSuspend: null,
          suspendedAt: null,
          suspendedReason: null,
          suspendedNote: null,
        },
      });

      await tx.user.updateMany({
        where: { companyId: id, status: UserStatus.SUSPENDED },
        data: { status: UserStatus.ACTIVE },
      });

      await tx.driver.updateMany({
        where: {
          OR: [{ companyId: id }, ...(userIds.length ? [{ userId: { in: userIds } }] : [])],
          status: DriverStatus.SUSPENDED,
        },
        data: { status: DriverStatus.ACTIVE },
      });

      await tx.vehicle.updateMany({
        where: { companyId: id, status: VehicleStatus.SUSPENDED },
        data: { status: VehicleStatus.ACTIVE },
      });

      if (partnerAdminIds.length) {
        await tx.adminUser.updateMany({
          where: { id: { in: partnerAdminIds }, status: AdminUserStatus.SUSPENDED },
          data: partnerRestore,
        });
      }

      return next;
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_REACTIVATED,
      actorAdminId: actorId,
      entityType: 'Company',
      entityId: id,
      metadata: { restoredStatus: restoreStatus },
    });

    return {
      id: updated.id,
      status: updated.status,
      statusBeforeSuspend: updated.statusBeforeSuspend,
      suspendedAt: updated.suspendedAt,
      suspendedReason: updated.suspendedReason,
      suspendedNote: updated.suspendedNote,
    };
  }

  /** Permanent delete â€” DRAFT companies only. */
  async deleteCompany(id: string, actorId: string) {
    this.ensureDatabase();

    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        users: { select: { id: true, email: true } },
        adminUsers: { select: { id: true, email: true } },
        _count: {
          select: {
            jobsAsSender: true,
            proposals: true,
            assignments: true,
          },
        },
      },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    if (company.status !== CompanyStatus.DRAFT) {
      throw new BadRequestException(
        'Only draft companies can be permanently deleted. Suspend non-draft companies instead.',
      );
    }
    if (
      company._count.jobsAsSender > 0 ||
      company._count.proposals > 0 ||
      company._count.assignments > 0
    ) {
      throw new BadRequestException(
        'Company has marketplace records and cannot be permanently deleted',
      );
    }

    const userIds = company.users.map((u) => u.id);
    const partnerAdminIds = (company.adminUsers ?? []).map((a) => a.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.driver.deleteMany({
        where: {
          OR: [{ companyId: id }, ...(userIds.length ? [{ userId: { in: userIds } }] : [])],
        },
      });
      if (userIds.length) {
        await tx.user.deleteMany({ where: { id: { in: userIds } } });
      }
      if (partnerAdminIds.length) {
        await tx.authSession.deleteMany({ where: { adminUserId: { in: partnerAdminIds } } });
        await tx.otpChallenge.deleteMany({ where: { adminUserId: { in: partnerAdminIds } } });
        await tx.adminScope.deleteMany({ where: { adminUserId: { in: partnerAdminIds } } });
        await tx.adminUser.deleteMany({ where: { id: { in: partnerAdminIds } } });
      }
      await tx.complianceDocument.deleteMany({ where: { companyId: id } });
      await tx.complianceCase.deleteMany({ where: { companyId: id } });
      await tx.company.delete({ where: { id } });
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_DELETED,
      actorAdminId: actorId,
      entityType: 'Company',
      entityId: id,
      metadata: {
        type: company.type,
        legalName: company.legalName,
        email: company.email,
        userEmails: company.users.map((u) => u.email),
      },
    });

    return { ok: true as const, id };
  }

  async getLead(id: string) {
    this.ensureDatabase();

    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        assignee: { select: { id: true, email: true, name: true } },
        notes: {
          orderBy: { createdAt: 'desc' },
          include: {
            author: { select: { id: true, email: true, name: true } },
          },
        },
        events: {
          orderBy: { createdAt: 'desc' },
          include: {
            actor: { select: { id: true, email: true, name: true } },
          },
        },
      },
    });

    if (!lead) {
      throw new NotFoundException('Lead not found');
    }

    return lead;
  }

  async updateLead(id: string, input: UpdateLeadInput, actorId: string) {
    this.ensureDatabase();

    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Lead not found');
    }

    if (input.assigneeId) {
      const assignee = await this.prisma.adminUser.findUnique({
        where: { id: input.assigneeId },
      });
      if (!assignee || !assignee.active) {
        throw new NotFoundException('Assignee not found');
      }
    }

    const lead = await this.prisma.lead.update({
      where: { id },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      },
      select: leadListSelect,
    });

    if (input.status !== undefined && input.status !== existing.status) {
      await this.audit.record({
        action: AuditAction.LEAD_STATUS_CHANGED,
        leadId: id,
        actorId,
        metadata: {
          from: existing.status,
          to: input.status,
          priority: input.priority ?? existing.priority,
          assigneeId: input.assigneeId ?? existing.assigneeId,
        },
      });
    } else {
      await this.audit.record({
        action: AuditAction.LEAD_UPDATED,
        leadId: id,
        actorId,
        metadata: {
          ...input,
        },
      });
    }

    return lead;
  }

  async deleteLead(id: string, actorId: string) {
    this.ensureDatabase();

    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Lead not found');
    }

    await this.audit.record({
      action: AuditAction.LEAD_DELETED,
      leadId: id,
      actorId,
      metadata: {
        type: existing.type,
        status: existing.status,
        email: existing.email,
        companyName: existing.companyName,
      },
    });

    await this.prisma.lead.delete({ where: { id } });

    return { ok: true as const, id };
  }

  async addNote(id: string, input: CreateLeadNoteInput, actorId: string) {
    this.ensureDatabase();

    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Lead not found');
    }

    const note = await this.prisma.leadNote.create({
      data: {
        leadId: id,
        authorId: actorId,
        body: input.body,
      },
      include: {
        author: { select: { id: true, email: true, name: true } },
      },
    });

    await this.audit.record({
      action: AuditAction.LEAD_NOTE_ADDED,
      leadId: id,
      actorId,
      metadata: { noteId: note.id },
    });

    return note;
  }

  async exportLeadsCsv(query: AdminLeadExportQuery): Promise<string> {
    this.ensureDatabase();

    const where = this.buildLeadWhere(query);
    const leads = await this.prisma.lead.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        status: true,
        email: true,
        phone: true,
        companyName: true,
        abn: true,
        acn: true,
        state: true,
        territory: true,
        priority: true,
        locale: true,
        source: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const headers = [
      'id',
      'type',
      'status',
      'email',
      'phone',
      'companyName',
      'abn',
      'acn',
      'state',
      'territory',
      'priority',
      'locale',
      'source',
      'createdAt',
      'updatedAt',
    ];

    const lines = [headers.join(',')];
    for (const lead of leads) {
      lines.push(
        [
          lead.id,
          lead.type,
          lead.status,
          lead.email,
          lead.phone ?? '',
          lead.companyName ?? '',
          lead.abn ?? '',
          lead.acn ?? '',
          lead.state ?? '',
          lead.territory ?? '',
          String(lead.priority),
          lead.locale ?? '',
          lead.source ?? '',
          lead.createdAt.toISOString(),
          lead.updatedAt.toISOString(),
        ]
          .map(csvEscape)
          .join(','),
      );
    }

    return `${lines.join('\n')}\n`;
  }

  async listAudit(query: AdminAuditQuery) {
    this.ensureDatabase();

    const where: Prisma.LeadEventWhereInput = {};
    if (query.action) where.action = query.action;
    if (query.leadId) where.leadId = query.leadId;

    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.leadEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
        include: {
          actor: { select: { id: true, email: true, name: true } },
          lead: {
            select: {
              id: true,
              type: true,
              email: true,
              companyName: true,
              status: true,
            },
          },
        },
      }),
      this.prisma.leadEvent.count({ where }),
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  private canHardDeleteJob(status: JobStatus) {
    return (
      status === JobStatus.DRAFT ||
      status === JobStatus.CANCELLED ||
      status === JobStatus.EXPIRED
    );
  }

  private canSoftDeleteJob(status: JobStatus) {
    return (
      status !== JobStatus.CANCELLED &&
      status !== JobStatus.EXPIRED &&
      status !== JobStatus.COMPLETED
    );
  }

  /**
   * True when every DROPOFF POD is FINALIZED but the trip is not finished yet
   * (driver still needs geofence exit / completeTripIfReady).
   */
  private podAwaitingDriverExit(params: {
    tripStatus: string | null | undefined;
    dropoffStopIds: string[];
    stopProgress: Array<{ jobStopId: string; podStatus: string }>;
  }): boolean {
    const status = params.tripStatus;
    if (!status || status === TripStatus.COMPLETED || status === TripStatus.CANCELLED) {
      return false;
    }
    if (params.dropoffStopIds.length < 1) return false;
    const byStop = new Map(params.stopProgress.map((p) => [p.jobStopId, p.podStatus]));
    return params.dropoffStopIds.every((id) => byStop.get(id) === 'FINALIZED');
  }

  async listJobs(query: AdminJobListQuery) {
    this.ensureDatabase();
    const where: Prisma.JobWhereInput = {};
    if (query.status) where.status = query.status as JobStatus;
    if (query.q) {
      const q = query.q;
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { receiverName: { contains: q, mode: 'insensitive' } },
        { receiverEmail: { contains: q, mode: 'insensitive' } },
        { senderCompany: { legalName: { contains: q, mode: 'insensitive' } } },
        { senderCompany: { email: { contains: q, mode: 'insensitive' } } },
        { id: { equals: q } },
      ];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [rows, total] = await Promise.all([
      this.prisma.job.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
        select: {
          id: true,
          status: true,
          title: true,
          pricingModel: true,
          receiverName: true,
          receiverEmail: true,
          estimateIncGstCents: true,
          createdAt: true,
          updatedAt: true,
          publishedAt: true,
          senderCompany: {
            select: { id: true, legalName: true, email: true, type: true },
          },
          assignment: {
            select: {
              id: true,
              status: true,
              lockedAt: true,
              carrierCompany: { select: { id: true, legalName: true } },
            },
          },
          stops: {
            where: { stopType: 'DROPOFF' },
            select: { id: true },
          },
          trip: {
            select: {
              id: true,
              status: true,
              startedAt: true,
              completedAt: true,
              stopProgress: { select: { jobStopId: true, podStatus: true } },
            },
          },
          _count: { select: { proposals: true } },
        },
      }),
      this.prisma.job.count({ where }),
    ]);

    return {
      items: rows.map((j) => {
        const podAwaitingExit = this.podAwaitingDriverExit({
          tripStatus: j.trip?.status,
          dropoffStopIds: j.stops.map((s) => s.id),
          stopProgress: j.trip?.stopProgress ?? [],
        });
        return {
          id: j.id,
          status: j.status,
          title: j.title,
          pricingModel: j.pricingModel,
          receiverName: j.receiverName,
          receiverEmail: j.receiverEmail,
          estimateIncGstCents: j.estimateIncGstCents,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          publishedAt: j.publishedAt,
          senderCompany: j.senderCompany,
          assignment: j.assignment,
          trip: j.trip
            ? {
                id: j.trip.id,
                status: j.trip.status,
                startedAt: j.trip.startedAt,
                completedAt: j.trip.completedAt,
                podAwaitingExit,
              }
            : null,
          proposalCount: j._count.proposals,
          canHardDelete: this.canHardDeleteJob(j.status),
          canSoftDelete: this.canSoftDeleteJob(j.status),
        };
      }),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async getJob(id: string) {
    this.ensureDatabase();
    const job = await this.prisma.job.findUnique({
      where: { id },
      include: {
        senderCompany: {
          select: { id: true, legalName: true, email: true, type: true, status: true },
        },
        stops: { orderBy: { sequence: 'asc' } },
        proposals: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            status: true,
            amountIncGstCents: true,
            etaMinutes: true,
            createdAt: true,
            carrierCompany: { select: { id: true, legalName: true } },
          },
        },
        assignment: {
          include: {
            carrierCompany: { select: { id: true, legalName: true } },
            vehicle: { select: { id: true, registration: true, vehicleClass: true } },
            driver: {
              select: {
                id: true,
                user: { select: { email: true, name: true } },
              },
            },
          },
        },
        trip: {
          select: {
            id: true,
            status: true,
            startedAt: true,
            completedAt: true,
            safetyPassedAt: true,
            massCheckOk: true,
            stopProgress: { select: { jobStopId: true, podStatus: true } },
          },
        },
        paymentEvents: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            status: true,
            amountIncGstCents: true,
            stripePaymentIntentId: true,
            createdAt: true,
          },
        },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    const dropoffStopIds = job.stops
      .filter((s) => s.stopType === 'DROPOFF')
      .map((s) => s.id);
    const trip = job.trip
      ? (() => {
          const { stopProgress, ...tripRest } = job.trip;
          return {
            ...tripRest,
            podAwaitingExit: this.podAwaitingDriverExit({
              tripStatus: job.trip.status,
              dropoffStopIds,
              stopProgress,
            }),
          };
        })()
      : null;
    return {
      ...job,
      trip,
      canHardDelete: this.canHardDeleteJob(job.status),
      canSoftDelete: this.canSoftDeleteJob(job.status),
    };
  }

  async hardDeleteJob(id: string, actorId: string) {
    this.ensureDatabase();
    const job = await this.prisma.job.findUnique({
      where: { id },
      include: {
        trip: { select: { id: true } },
        assignment: { select: { id: true, proposalId: true } },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    if (!this.canHardDeleteJob(job.status)) {
      throw new BadRequestException({
        message:
          'Hard delete is only for draft, cancelled, or expired jobs. Use soft delete instead.',
        code: 'JOB_HARD_DELETE_NOT_ALLOWED',
        status: job.status,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      if (job.trip) {
        await tx.surcharge.deleteMany({ where: { tripId: job.trip.id } });
        await tx.tripLocationSample.deleteMany({ where: { tripId: job.trip.id } });
        await tx.tripStopProgress.deleteMany({ where: { tripId: job.trip.id } });
        await tx.tripException.updateMany({
          where: { tripId: job.trip.id },
          data: { tripId: null },
        });
        await tx.trip.delete({ where: { id: job.trip.id } });
      }
      await tx.tripException.deleteMany({ where: { jobId: id } });
      await tx.surcharge.deleteMany({ where: { jobId: id } });
      if (job.assignment) {
        await tx.assignment.delete({ where: { id: job.assignment.id } });
      }
      await tx.proposal.deleteMany({ where: { jobId: id } });
      await tx.paymentEvent.deleteMany({ where: { jobId: id } });
      await tx.settlementLine.deleteMany({ where: { jobId: id } });
      await tx.job.delete({ where: { id } });
    });

    await this.audit.recordPlatform({
      action: AuditAction.JOB_DELETED,
      actorAdminId: actorId,
      entityType: 'Job',
      entityId: id,
      metadata: {
        previousStatus: job.status,
        title: job.title,
        senderCompanyId: job.senderCompanyId,
        hard: true,
      },
    });

    return { id, deleted: true as const, mode: 'hard' as const };
  }

  async softDeleteJob(id: string, actorId: string) {
    this.ensureDatabase();
    const job = await this.prisma.job.findUnique({
      where: { id },
      include: {
        trip: { select: { id: true, status: true } },
        assignment: { select: { id: true, status: true } },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    if (!this.canSoftDeleteJob(job.status)) {
      throw new BadRequestException({
        message: 'Job is already closed and cannot be soft-deleted',
        code: 'JOB_SOFT_DELETE_NOT_ALLOWED',
        status: job.status,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.proposal.updateMany({
        where: { jobId: id, status: ProposalStatus.SUBMITTED },
        data: { status: ProposalStatus.EXPIRED },
      });
      if (
        job.assignment &&
        job.assignment.status !== AssignmentStatus.CANCELLED &&
        job.assignment.status !== AssignmentStatus.COMPLETED
      ) {
        await tx.assignment.update({
          where: { id: job.assignment.id },
          data: { status: AssignmentStatus.CANCELLED },
        });
      }
      if (
        job.trip &&
        job.trip.status !== TripStatus.COMPLETED &&
        job.trip.status !== TripStatus.CANCELLED
      ) {
        await tx.trip.update({
          where: { id: job.trip.id },
          data: { status: TripStatus.CANCELLED },
        });
      }
      await tx.job.update({
        where: { id },
        data: { status: JobStatus.CANCELLED },
      });
    });

    await this.audit.recordPlatform({
      action: AuditAction.JOB_CANCELLED,
      actorAdminId: actorId,
      entityType: 'Job',
      entityId: id,
      metadata: {
        previousStatus: job.status,
        title: job.title,
        soft: true,
      },
    });

    return {
      id,
      deleted: false as const,
      mode: 'soft' as const,
      status: JobStatus.CANCELLED,
    };
  }

  private async ensurePlatformSettings() {
    return this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    });
  }

  async getPlatformSettings() {
    this.ensureDatabase();
    const row = await this.ensurePlatformSettings();
    return {
      id: row.id,
      rescueDiscountPercent: row.rescueDiscountPercent,
      marketplaceRelistSlaMs: row.marketplaceRelistSlaMs,
      driverUnavailableScoreDelta: row.driverUnavailableScoreDelta,
      carrierMarketplaceReleaseScoreDelta: row.carrierMarketplaceReleaseScoreDelta,
      carrierClearingDays: row.carrierClearingDays ?? 7,
      updatedAt: row.updatedAt,
    };
  }

  async patchPlatformSettings(input: PlatformSettingsPatchInput, actorAdminId: string) {
    this.ensureDatabase();
    await this.ensurePlatformSettings();
    const data: Prisma.PlatformSettingsUpdateInput = {};
    if (input.rescueDiscountPercent !== undefined) {
      data.rescueDiscountPercent = input.rescueDiscountPercent;
    }
    if (input.marketplaceRelistSlaMs !== undefined) {
      data.marketplaceRelistSlaMs = input.marketplaceRelistSlaMs;
    }
    if (input.driverUnavailableScoreDelta !== undefined) {
      data.driverUnavailableScoreDelta = input.driverUnavailableScoreDelta;
    }
    if (input.carrierMarketplaceReleaseScoreDelta !== undefined) {
      data.carrierMarketplaceReleaseScoreDelta = input.carrierMarketplaceReleaseScoreDelta;
    }
    if (input.carrierClearingDays !== undefined) {
      data.carrierClearingDays = input.carrierClearingDays;
    }
    const updated = await this.prisma.platformSettings.update({
      where: { id: 'default' },
      data,
    });
    await this.audit.recordPlatform({
      action: AuditAction.PLATFORM_SETTINGS_UPDATED,
      actorAdminId,
      entityType: 'PlatformSettings',
      entityId: 'default',
      metadata: input,
    });
    return {
      id: updated.id,
      rescueDiscountPercent: updated.rescueDiscountPercent,
      marketplaceRelistSlaMs: updated.marketplaceRelistSlaMs,
      driverUnavailableScoreDelta: updated.driverUnavailableScoreDelta,
      carrierMarketplaceReleaseScoreDelta: updated.carrierMarketplaceReleaseScoreDelta,
      carrierClearingDays: updated.carrierClearingDays ?? 7,
      updatedAt: updated.updatedAt,
    };
  }

  async listVehicleClasses(): Promise<VehicleClassDto[]> {
    this.ensureDatabase();
    let rows = await this.prisma.vehicleClassConfig.findMany({
      orderBy: { rank: 'asc' },
    });
    if (rows.length === 0) {
      for (const c of DEFAULT_VEHICLE_CLASSES) {
        await this.prisma.vehicleClassConfig.upsert({
          where: { code: c.code },
          update: {},
          create: {
            code: c.code,
            name: c.name ?? c.code,
            rank: c.rank,
            maxChargeableWeightKg: c.maxChargeableWeightKg,
            maxLengthCm: c.maxLengthCm,
            maxWidthCm: c.maxWidthCm,
            maxHeightCm: c.maxHeightCm,
            minLicenceClass: c.minLicenceClass,
            suggestedGvmKg: c.suggestedGvmKg ?? 3500,
            suggestedTareKg: c.suggestedTareKg ?? 2000,
            isActive: true,
          },
        });
      }
      rows = await this.prisma.vehicleClassConfig.findMany({
        orderBy: { rank: 'asc' },
      });
    }

    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      rank: r.rank,
      maxChargeableWeightKg: r.maxChargeableWeightKg,
      maxLengthCm: r.maxLengthCm,
      maxWidthCm: r.maxWidthCm,
      maxHeightCm: r.maxHeightCm,
      minLicenceClass: r.minLicenceClass,
      suggestedGvmKg: r.suggestedGvmKg,
      suggestedTareKg: r.suggestedTareKg,
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async createVehicleClass(input: VehicleClassCreateInput, actorAdminId: string): Promise<VehicleClassDto> {
    this.ensureDatabase();
    const existing = await this.prisma.vehicleClassConfig.findUnique({
      where: { code: input.code },
    });
    if (existing) {
      throw new ConflictException(`A vehicle class with code '${input.code}' already exists`);
    }

    const row = await this.prisma.vehicleClassConfig.create({
      data: {
        code: input.code,
        name: input.name,
        rank: input.rank,
        maxChargeableWeightKg: input.maxChargeableWeightKg,
        maxLengthCm: input.maxLengthCm,
        maxWidthCm: input.maxWidthCm,
        maxHeightCm: input.maxHeightCm,
        minLicenceClass: input.minLicenceClass,
        suggestedGvmKg: input.suggestedGvmKg,
        suggestedTareKg: input.suggestedTareKg,
        isActive: input.isActive ?? true,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.VEHICLE_CLASS_CREATED,
      actorAdminId,
      entityType: 'VehicleClassConfig',
      entityId: row.id,
      metadata: input,
    });

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      rank: row.rank,
      maxChargeableWeightKg: row.maxChargeableWeightKg,
      maxLengthCm: row.maxLengthCm,
      maxWidthCm: row.maxWidthCm,
      maxHeightCm: row.maxHeightCm,
      minLicenceClass: row.minLicenceClass,
      suggestedGvmKg: row.suggestedGvmKg,
      suggestedTareKg: row.suggestedTareKg,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async updateVehicleClass(
    id: string,
    input: VehicleClassUpdateInput,
    actorAdminId: string,
  ): Promise<VehicleClassDto> {
    this.ensureDatabase();
    const existing = await this.prisma.vehicleClassConfig.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('Vehicle class not found');
    }

    const row = await this.prisma.vehicleClassConfig.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.rank !== undefined ? { rank: input.rank } : {}),
        ...(input.maxChargeableWeightKg !== undefined
          ? { maxChargeableWeightKg: input.maxChargeableWeightKg }
          : {}),
        ...(input.maxLengthCm !== undefined ? { maxLengthCm: input.maxLengthCm } : {}),
        ...(input.maxWidthCm !== undefined ? { maxWidthCm: input.maxWidthCm } : {}),
        ...(input.maxHeightCm !== undefined ? { maxHeightCm: input.maxHeightCm } : {}),
        ...(input.minLicenceClass !== undefined ? { minLicenceClass: input.minLicenceClass } : {}),
        ...(input.suggestedGvmKg !== undefined ? { suggestedGvmKg: input.suggestedGvmKg } : {}),
        ...(input.suggestedTareKg !== undefined ? { suggestedTareKg: input.suggestedTareKg } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.VEHICLE_CLASS_UPDATED,
      actorAdminId,
      entityType: 'VehicleClassConfig',
      entityId: row.id,
      metadata: input,
    });

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      rank: row.rank,
      maxChargeableWeightKg: row.maxChargeableWeightKg,
      maxLengthCm: row.maxLengthCm,
      maxWidthCm: row.maxWidthCm,
      maxHeightCm: row.maxHeightCm,
      minLicenceClass: row.minLicenceClass,
      suggestedGvmKg: row.suggestedGvmKg,
      suggestedTareKg: row.suggestedTareKg,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async deleteVehicleClass(
    id: string,
    actorAdminId: string,
  ): Promise<{ success: boolean; deletedCode: string }> {
    this.ensureDatabase();
    const existing = await this.prisma.vehicleClassConfig.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('Vehicle class not found');
    }

    const vehicleCount = await this.prisma.vehicle.count({
      where: { vehicleClass: existing.code },
    });
    if (vehicleCount > 0) {
      throw new BadRequestException({
        message: `Cannot delete vehicle class '${existing.code}' because it is in use by ${vehicleCount} vehicle(s). Deactivate it instead.`,
        code: 'VEHICLE_CLASS_IN_USE',
      });
    }

    const jobCount = await this.prisma.job.count({
      where: {
        OR: [
          { minVehicleClass: existing.code },
          { recommendedVehicleClass: existing.code },
        ],
      },
    });
    if (jobCount > 0) {
      throw new BadRequestException({
        message: `Cannot delete vehicle class '${existing.code}' because it is referenced by ${jobCount} job(s). Deactivate it instead.`,
        code: 'VEHICLE_CLASS_IN_USE',
      });
    }

    await this.prisma.vehicleClassConfig.delete({
      where: { id },
    });

    await this.audit.recordPlatform({
      action: AuditAction.VEHICLE_CLASS_DELETED,
      actorAdminId,
      entityType: 'VehicleClassConfig',
      entityId: id,
      metadata: { code: existing.code, name: existing.name },
    });

    return { success: true, deletedCode: existing.code };
  }
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
