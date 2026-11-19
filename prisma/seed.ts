import {
  PrismaClient,
  AdminRole,
  AdminScopeType,
  AssignmentStatus,
  CompanyStatus,
  CompanyType,
  JobStatus,
  PaymentEventStatus,
  PaymentEventType,
  PlatformRole,
  ProposalStatus,
  SenderAccountType,
  SettlementLineStatus,
  SettlementRecipientType,
  TripStatus,
  UserStatus,
} from '@prisma/client';

const prisma = new PrismaClient();

const AU_REGIONS: Array<{
  code: string;
  name: string;
  enabled: boolean;
  territoryCode: string;
  territoryName: string;
}> = [
  { code: 'VIC', name: 'Victoria', enabled: true, territoryCode: 'MEL', territoryName: 'Melbourne Metro' },
  { code: 'NSW', name: 'New South Wales', enabled: false, territoryCode: 'SYD', territoryName: 'Sydney Metro' },
  { code: 'QLD', name: 'Queensland', enabled: false, territoryCode: 'BNE', territoryName: 'Brisbane Metro' },
  { code: 'SA', name: 'South Australia', enabled: false, territoryCode: 'ADL', territoryName: 'Adelaide Metro' },
  { code: 'WA', name: 'Western Australia', enabled: false, territoryCode: 'PER', territoryName: 'Perth Metro' },
  { code: 'TAS', name: 'Tasmania', enabled: false, territoryCode: 'HBA', territoryName: 'Hobart Metro' },
  { code: 'NT', name: 'Northern Territory', enabled: false, territoryCode: 'DRW', territoryName: 'Darwin Metro' },
  { code: 'ACT', name: 'Australian Capital Territory', enabled: false, territoryCode: 'CBR', territoryName: 'Canberra Metro' },
];

async function seedRegions() {
  for (const region of AU_REGIONS) {
    const upsertedRegion = await prisma.region.upsert({
      where: { code: region.code },
      update: {
        name: region.name,
        ...(region.enabled ? { enabled: true } : {}),
      },
      create: {
        code: region.code,
        name: region.name,
        enabled: region.enabled,
      },
    });

    await prisma.localTerritory.upsert({
      where: {
        regionId_code: { regionId: upsertedRegion.id, code: region.territoryCode },
      },
      update: { name: region.territoryName, enabled: true },
      create: {
        regionId: upsertedRegion.id,
        code: region.territoryCode,
        name: region.territoryName,
        enabled: true,
      },
    });
  }

  const vic = await prisma.region.findUniqueOrThrow({ where: { code: 'VIC' } });

  // eslint-disable-next-line no-console
  console.log(`Seeded 8 AU regions + metro territories (VIC enabled=${vic.enabled ? 'yes' : 'no'})`);
  return vic;
}

async function seedSuperAdmin() {
  const email = (process.env.SEED_SUPER_ADMIN_EMAIL ?? 'cloxadmin@yopmail.com').toLowerCase();
  const name = process.env.SEED_SUPER_ADMIN_NAME ?? 'CLOX Super Admin';

  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: {
      name,
      role: AdminRole.SUPER_ADMIN,
      active: true,
    },
    create: {
      email,
      name,
      role: AdminRole.SUPER_ADMIN,
      active: true,
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded Super Admin: ${admin.email} (${admin.id})`);
}

async function seedScopedAdmins(vicRegionId: string) {
  const mel = await prisma.localTerritory.findUniqueOrThrow({
    where: { regionId_code: { regionId: vicRegionId, code: 'MEL' } },
  });

  const stateEmail = (
    process.env.SEED_STATE_MASTER_EMAIL ?? 'state.vic@yopmail.com'
  ).toLowerCase();
  const localEmail = (
    process.env.SEED_LOCAL_BDE_EMAIL ?? 'local.mel@yopmail.com'
  ).toLowerCase();

  const state = await prisma.adminUser.upsert({
    where: { email: stateEmail },
    update: { role: AdminRole.STATE_MASTER, active: true, name: 'VIC State Master' },
    create: {
      email: stateEmail,
      name: 'VIC State Master',
      role: AdminRole.STATE_MASTER,
      active: true,
    },
  });

  await prisma.adminScope.deleteMany({ where: { adminUserId: state.id } });
  await prisma.adminScope.create({
    data: {
      adminUserId: state.id,
      scopeType: AdminScopeType.STATE,
      regionId: vicRegionId,
    },
  });

  const local = await prisma.adminUser.upsert({
    where: { email: localEmail },
    update: { role: AdminRole.LOCAL_BDE, active: true, name: 'Melbourne Local BDE' },
    create: {
      email: localEmail,
      name: 'Melbourne Local BDE',
      role: AdminRole.LOCAL_BDE,
      active: true,
    },
  });

  await prisma.adminScope.deleteMany({ where: { adminUserId: local.id } });
  await prisma.adminScope.create({
    data: {
      adminUserId: local.id,
      scopeType: AdminScopeType.LOCAL,
      regionId: vicRegionId,
      localTerritoryId: mel.id,
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded State Master: ${state.email}`);
  // eslint-disable-next-line no-console
  console.log(`Seeded Local BDE: ${local.email}`);
}

async function seedMarketplaceUsers(vicRegionId: string) {
  const senderCompany = await prisma.company.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    update: {
      legalName: 'QA Sender Pty Ltd',
      status: CompanyStatus.ACTIVE,
      homeRegionId: vicRegionId,
      senderAccountType: SenderAccountType.BUSINESS,
      abn: '51824753556',
      invoiceLegalName: 'QA Sender Pty Ltd',
      invoiceAddressLine1: '1 Collins St',
      invoiceSuburb: 'Melbourne',
      invoiceState: 'VIC',
      invoicePostcode: '3000',
      gstRegistered: true,
      paymentReady: true,
      stripeCustomerId: 'cus_mock_seed_sender',
      stripeDefaultPaymentMethodId: 'pm_mock_seed',
    },
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      type: CompanyType.SENDER,
      status: CompanyStatus.ACTIVE,
      legalName: 'QA Sender Pty Ltd',
      abn: '51824753556',
      homeRegionId: vicRegionId,
      senderAccountType: SenderAccountType.BUSINESS,
      invoiceLegalName: 'QA Sender Pty Ltd',
      invoiceAddressLine1: '1 Collins St',
      invoiceSuburb: 'Melbourne',
      invoiceState: 'VIC',
      invoicePostcode: '3000',
      gstRegistered: true,
      paymentReady: true,
      stripeCustomerId: 'cus_mock_seed_sender',
      stripeDefaultPaymentMethodId: 'pm_mock_seed',
    },
  });

  const carrierCompany = await prisma.company.upsert({
    where: { id: '00000000-0000-4000-8000-000000000002' },
    update: {
      legalName: 'QA Carrier Pty Ltd',
      status: CompanyStatus.BID_ELIGIBLE,
      homeRegionId: vicRegionId,
      abn: '53004085616',
      stripeConnectAccountId: 'acct_mock_seed_carrier',
      stripeConnectPayoutsEnabled: true,
      capabilities: ['TAIL_LIFT'],
      serviceRegionCodes: ['VIC'],
    },
    create: {
      id: '00000000-0000-4000-8000-000000000002',
      type: CompanyType.CARRIER,
      status: CompanyStatus.BID_ELIGIBLE,
      legalName: 'QA Carrier Pty Ltd',
      abn: '53004085616',
      homeRegionId: vicRegionId,
      stripeConnectAccountId: 'acct_mock_seed_carrier',
      stripeConnectPayoutsEnabled: true,
      capabilities: ['TAIL_LIFT'],
      serviceRegionCodes: ['VIC'],
    },
  });

  await prisma.vehicle.upsert({
    where: { id: '00000000-0000-4000-8000-0000000000a1' },
    update: {
      companyId: carrierCompany.id,
      status: 'ACTIVE',
      label: 'QA Rigid',
      registration: 'CLOX01',
      vehicleClass: 'RIGID_1_2T',
      tareKg: 3500,
      gvmKg: 8000,
    },
    create: {
      id: '00000000-0000-4000-8000-0000000000a1',
      companyId: carrierCompany.id,
      status: 'ACTIVE',
      label: 'QA Rigid',
      registration: 'CLOX01',
      vehicleClass: 'RIGID_1_2T',
      tareKg: 3500,
      gvmKg: 8000,
    },
  });

  const users = [
    {
      email: (process.env.SEED_SENDER_EMAIL ?? 'sender.qa@yopmail.com').toLowerCase(),
      role: PlatformRole.SENDER,
      name: 'QA Sender',
      companyId: senderCompany.id,
      phone: '+61400000001',
    },
    {
      email: (process.env.SEED_CARRIER_EMAIL ?? 'carrier.qa@yopmail.com').toLowerCase(),
      role: PlatformRole.TRANSPORT_COMPANY,
      name: 'QA Carrier Admin',
      companyId: carrierCompany.id,
      phone: '+61400000002',
    },
    {
      email: (process.env.SEED_DRIVER_EMAIL ?? 'driver.qa@yopmail.com').toLowerCase(),
      role: PlatformRole.DRIVER,
      name: 'QA Driver',
      companyId: carrierCompany.id,
      phone: '+61400000003',
    },
  ] as const;

  for (const u of users) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        role: u.role,
        status: UserStatus.ACTIVE,
        name: u.name,
        companyId: u.companyId,
        phone: u.phone,
      },
      create: {
        email: u.email,
        role: u.role,
        status: UserStatus.ACTIVE,
        name: u.name,
        companyId: u.companyId,
        phone: u.phone,
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded ${u.role}: ${user.email}`);

    if (u.role === PlatformRole.DRIVER) {
      await prisma.driver.upsert({
        where: { userId: user.id },
        update: {
          companyId: carrierCompany.id,
          status: 'ACTIVE',
          licenceNo: 'VIC-QA-001',
          // LR required for seeded RIGID_1_2T vehicle (matching licence gate).
          licenceClass: 'LR',
          licenceExpiry: new Date('2030-12-31T00:00:00.000Z'),
          nhvrAcknowledgedAt: new Date(),
          inviteAcceptedAt: new Date(),
        },
        create: {
          userId: user.id,
          companyId: carrierCompany.id,
          status: 'ACTIVE',
          licenceNo: 'VIC-QA-001',
          licenceClass: 'LR',
          licenceExpiry: new Date('2030-12-31T00:00:00.000Z'),
          nhvrAcknowledgedAt: new Date(),
          inviteAcceptedAt: new Date(),
        },
      });
    }
  }

  return { senderCompanyId: senderCompany.id, carrierCompanyId: carrierCompany.id };
}

async function seedPolicy() {
  await prisma.policyVersion.upsert({
    where: { key_version: { key: 'MIN_BASE_FARE', version: 1 } },
    update: {
      payload: { perKmMinCents: 5000, hourlyMinCents: 20000 },
      publishedAt: new Date(),
    },
    create: {
      key: 'MIN_BASE_FARE',
      version: 1,
      payload: { perKmMinCents: 5000, hourlyMinCents: 20000 },
      publishedAt: new Date(),
    },
  });
  // eslint-disable-next-line no-console
  console.log('Seeded PolicyVersion MIN_BASE_FARE v1');

  await prisma.policyVersion.upsert({
    where: { key_version: { key: 'geofence.v1', version: 1 } },
    update: {
      payload: {
        radiusMeters: 200,
        antiBounceSamples: 2,
        freeWaitPickupMinutes: 30,
        freeWaitDropMinutes: 60,
        waitingCentsPerMinuteIncGst: 100,
        massBaseCentsIncGst: 5000,
        massPerKgCentsIncGst: 100,
        massTolerancePct: 2,
        /** DEV demo: free wait seconds override (null = use minutes). */
        freeWaitSecondsOverride: 30,
      },
      publishedAt: new Date(),
    },
    create: {
      key: 'geofence.v1',
      version: 1,
      payload: {
        radiusMeters: 200,
        antiBounceSamples: 2,
        freeWaitPickupMinutes: 30,
        freeWaitDropMinutes: 60,
        waitingCentsPerMinuteIncGst: 100,
        massBaseCentsIncGst: 5000,
        massPerKgCentsIncGst: 100,
        massTolerancePct: 2,
        freeWaitSecondsOverride: 30,
      },
      publishedAt: new Date(),
    },
  });
  // eslint-disable-next-line no-console
  console.log('Seeded PolicyVersion geofence.v1');

  await prisma.policyVersion.upsert({
    where: { key_version: { key: 'revenue_split.v1', version: 1 } },
    update: {
      payload: {
        carrierPercent: 70,
        superPercent: 15,
        statePercent: 10,
        localPercent: 5,
        notes: 'Pilot default (G0)',
      },
      publishedAt: new Date(),
    },
    create: {
      key: 'revenue_split.v1',
      version: 1,
      payload: {
        carrierPercent: 70,
        superPercent: 15,
        statePercent: 10,
        localPercent: 5,
        notes: 'Pilot default (G0)',
      },
      publishedAt: new Date(),
    },
  });
  // eslint-disable-next-line no-console
  console.log('Seeded PolicyVersion revenue_split.v1');
}

async function seedPilotJobAndTrip(vicRegionId: string, carrierCompanyId: string, senderCompanyId: string) {
  const driver = await prisma.driver.findFirst({
    where: { companyId: carrierCompanyId },
  });
  if (!driver) return;

  const jobId = '00000000-0000-4000-8000-0000000000f1';
  const proposalId = '00000000-0000-4000-8000-0000000000f2';
  const assignmentId = '00000000-0000-4000-8000-0000000000f3';
  const tripId = '00000000-0000-4000-8000-0000000000f4';
  const pickupStopId = '00000000-0000-4000-8000-0000000000s1';
  const dropoffStopId = '00000000-0000-4000-8000-0000000000s2';
  const paymentEventId = '00000000-0000-4000-8000-0000000000e1';

  await prisma.job.upsert({
    where: { id: jobId },
    update: {
      status: JobStatus.IN_TRANSIT,
      title: 'Melbourne Metro Pilot Freight Delivery',
      originRegionId: vicRegionId,
    },
    create: {
      id: jobId,
      senderCompanyId,
      status: JobStatus.IN_TRANSIT,
      title: 'Melbourne Metro Pilot Freight Delivery',
      pricingModel: 'PER_KM',
      minVehicleClass: 'RIGID_1_2T',
      recommendedVehicleClass: 'RIGID_1_2T',
      loadTypes: ['GENERAL'],
      deadWeightKg: 1500,
      chargeableWeightKg: 1500,
      lengthCm: 300,
      widthCm: 180,
      heightCm: 180,
      originRegionId: vicRegionId,
      estimateExGstCents: 15000,
      estimateGstCents: 1500,
      estimateIncGstCents: 16500,
      routeDistanceKm: 12.5,
      routeDurationMinutes: 35,
      billableHours: 1.0,
      receiverName: 'Jamie Receiver',
      receiverEmail: 'receiver.qa@yopmail.com',
      receiverPhone: '+61400000004',
      publishedAt: new Date(),
    },
  });

  await prisma.jobStop.upsert({
    where: { id: pickupStopId },
    update: {},
    create: {
      id: pickupStopId,
      jobId,
      sequence: 0,
      stopType: 'PICKUP',
      label: 'Melbourne City Depot',
      addressLine: '1 Collins St',
      suburb: 'Melbourne',
      state: 'VIC',
      postcode: '3000',
      lat: -37.8136,
      lng: 144.9631,
    },
  });

  await prisma.jobStop.upsert({
    where: { id: dropoffStopId },
    update: {},
    create: {
      id: dropoffStopId,
      jobId,
      sequence: 1,
      stopType: 'DROPOFF',
      label: 'Richmond Retail Hub',
      addressLine: '100 Swan St',
      suburb: 'Richmond',
      state: 'VIC',
      postcode: '3121',
      lat: -37.8248,
      lng: 144.9961,
      receiverName: 'Jamie Receiver',
      receiverEmail: 'receiver.qa@yopmail.com',
    },
  });

  await prisma.proposal.upsert({
    where: { id: proposalId },
    update: { status: ProposalStatus.ACCEPTED },
    create: {
      id: proposalId,
      jobId,
      carrierCompanyId,
      driverId: driver.id,
      vehicleId: '00000000-0000-4000-8000-0000000000a1',
      status: ProposalStatus.ACCEPTED,
      amountIncGstCents: 16500,
      amountExGstCents: 15000,
      amountGstCents: 1500,
      etaMinutes: 30,
    },
  });

  await prisma.assignment.upsert({
    where: { id: assignmentId },
    update: { status: AssignmentStatus.LOCKED, lockedAt: new Date() },
    create: {
      id: assignmentId,
      jobId,
      proposalId,
      carrierCompanyId,
      driverId: driver.id,
      vehicleId: '00000000-0000-4000-8000-0000000000a1',
      status: AssignmentStatus.LOCKED,
      lockedAt: new Date(),
    },
  });

  await prisma.trip.upsert({
    where: { id: tripId },
    update: { status: TripStatus.IN_TRANSIT },
    create: {
      id: tripId,
      jobId,
      assignmentId,
      status: TripStatus.IN_TRANSIT,
      startedAt: new Date(),
      safetyPassedAt: new Date(),
      declaredMassKg: 1500,
      actualMassKg: 1500,
      massCheckOk: true,
      massCheckedAt: new Date(),
    },
  });

  await prisma.tripStopProgress.upsert({
    where: { tripId_jobStopId: { tripId, jobStopId: pickupStopId } },
    update: {},
    create: {
      tripId,
      jobStopId: pickupStopId,
      arrivalRecorded: true,
      enteredAt: new Date(Date.now() - 25 * 60 * 1000),
      exitedAt: new Date(Date.now() - 15 * 60 * 1000),
    },
  });

  await prisma.tripStopProgress.upsert({
    where: { tripId_jobStopId: { tripId, jobStopId: dropoffStopId } },
    update: {},
    create: {
      tripId,
      jobStopId: dropoffStopId,
      arrivalRecorded: false,
    },
  });

  await prisma.paymentEvent.upsert({
    where: { id: paymentEventId },
    update: {},
    create: {
      id: paymentEventId,
      jobId,
      type: PaymentEventType.CHARGE,
      status: PaymentEventStatus.SUCCEEDED,
      amountExGstCents: 15000,
      amountGstCents: 1500,
      amountIncGstCents: 16500,
      stripePaymentIntentId: 'pi_mock_seed_pilot',
    },
  });

  await prisma.settlementLine.upsert({
    where: { id: '00000000-0000-4000-8000-0000000000l1' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-0000000000l1',
      jobId,
      recipientType: SettlementRecipientType.CARRIER,
      amountCents: 11550,
      status: SettlementLineStatus.ACCRUED,
      regionId: vicRegionId,
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded Victorian live pilot job (${jobId}) and trip (${tripId})`);
}

async function seedVehicleClasses() {
  const { DEFAULT_VEHICLE_CLASSES, vehicleClassConfigWriteData } = await import(
    '../src/modules/jobs/job-pricing.util'
  );

  for (const c of DEFAULT_VEHICLE_CLASSES) {
    const data = vehicleClassConfigWriteData(c);
    await prisma.vehicleClassConfig.upsert({
      where: { code: c.code },
      // Seed is authoritative for default catalog rows (rates/dims/rank/active).
      update: {
        name: data.name,
        rank: data.rank,
        maxChargeableWeightKg: data.maxChargeableWeightKg,
        maxLengthCm: data.maxLengthCm,
        maxWidthCm: data.maxWidthCm,
        maxHeightCm: data.maxHeightCm,
        minLicenceClass: data.minLicenceClass,
        suggestedGvmKg: data.suggestedGvmKg,
        suggestedTareKg: data.suggestedTareKg,
        isActive: data.isActive,
        perKmRateCents: data.perKmRateCents,
        hourlyRateCents: data.hourlyRateCents,
        perKmMinBaseCents: data.perKmMinBaseCents,
        hourlyMinBaseCents: data.hourlyMinBaseCents,
        perKmGuidanceMinCents: data.perKmGuidanceMinCents,
        perKmGuidanceMaxCents: data.perKmGuidanceMaxCents,
        hourlyGuidanceMinCents: data.hourlyGuidanceMinCents,
        hourlyGuidanceMaxCents: data.hourlyGuidanceMaxCents,
      },
      create: data,
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${DEFAULT_VEHICLE_CLASSES.length} vehicle classes (docs catalog)`);
}

async function seedRateFloorVersion() {
  const {
    DEFAULT_RATE_FLOOR_LINES,
    DEFAULT_RATE_FLOOR_VERSION_LABEL,
    DEFAULT_RATE_FLOOR_VERSION_PARAMS,
  } = await import('../src/modules/rate-floor/rate-floor.defaults');

  const existing = await prisma.rateFloorVersion.findFirst({
    where: { status: 'PUBLISHED' },
    select: { id: true },
  });
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`Rate floor PUBLISHED version already present (${existing.id})`);
    return;
  }

  const { DEFAULT_LABOUR_MULTIPLIERS } = await import(
    '../src/modules/rate-floor/rate-floor.labour'
  );
  const { DEFAULT_BODY_LOADINGS } = await import('../src/modules/rate-floor/rate-floor.body');

  // Nested labour/body creates trip Prisma CreateInput XOR typing in seed; createMany after.
  const version = await prisma.rateFloorVersion.create({
    data: {
      label: DEFAULT_RATE_FLOOR_VERSION_LABEL,
      status: 'PUBLISHED',
      effectiveFrom: new Date(),
      referenceDieselCpl: DEFAULT_RATE_FLOOR_VERSION_PARAMS.referenceDieselCpl,
      labourRateHrCents: DEFAULT_RATE_FLOOR_VERSION_PARAMS.labourRateHrCents,
      minHours: DEFAULT_RATE_FLOOR_VERSION_PARAMS.minHours,
      minKmChargeKm: DEFAULT_RATE_FLOOR_VERSION_PARAMS.minKmChargeKm,
      backhaulFactor: DEFAULT_RATE_FLOOR_VERSION_PARAMS.backhaulFactor,
      lines: {
        create: DEFAULT_RATE_FLOOR_LINES.map((l) => ({
          vehicleClassCode: l.vehicleClassCode,
          hourlyFloorCents: l.hourlyFloorCents,
          kmFloorCents: l.kmFloorCents,
          variableKmCents: l.variableKmCents,
          litresPerKm: l.litresPerKm,
          basis: l.basis,
        })),
      },
    },
  });

  await prisma.rateFloorLabourMultiplier.createMany({
    data: DEFAULT_LABOUR_MULTIPLIERS.map((m) => ({
      versionId: version.id,
      periodCode: m.periodCode,
      multiplier: m.multiplier,
    })),
    skipDuplicates: true,
  });
  await prisma.rateFloorBodyLoading.createMany({
    data: DEFAULT_BODY_LOADINGS.map((b) => ({
      versionId: version.id,
      bodyCode: b.bodyCode,
      loadingPct: b.loadingPct,
      minHours: b.minHours,
    })),
    skipDuplicates: true,
  });

  // eslint-disable-next-line no-console
  console.log(
    `Seeded rate floor version ${version.id} (${DEFAULT_RATE_FLOOR_LINES.length} lines)`,
  );
}

async function seedPublicHolidays() {
  const existing = await prisma.publicHoliday.findFirst({ select: { id: true } });
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`Public holidays already present (${existing.id})`);
    return;
  }
  const rows = [
    { state: 'NATIONAL', holidayDate: '2026-01-01', name: "New Year's Day" },
    { state: 'NATIONAL', holidayDate: '2026-01-26', name: 'Australia Day' },
    { state: 'NATIONAL', holidayDate: '2026-04-03', name: 'Good Friday' },
    { state: 'NATIONAL', holidayDate: '2026-04-06', name: 'Easter Monday' },
    { state: 'NATIONAL', holidayDate: '2026-04-25', name: 'ANZAC Day' },
    { state: 'NATIONAL', holidayDate: '2026-12-25', name: 'Christmas Day' },
    { state: 'NATIONAL', holidayDate: '2026-12-26', name: 'Boxing Day' },
    { state: 'VIC', holidayDate: '2026-11-03', name: 'Melbourne Cup Day' },
  ];
  await prisma.publicHoliday.createMany({
    data: rows.map((r) => ({
      state: r.state,
      holidayDate: new Date(`${r.holidayDate}T00:00:00.000Z`),
      name: r.name,
    })),
  });
  // eslint-disable-next-line no-console
  console.log(`Seeded ${rows.length} public holidays (Award stub → Sunday multiplier)`);
}

async function seedFuelIndex() {
  const { DEFAULT_RATE_FLOOR_VERSION_PARAMS } = await import(
    '../src/modules/rate-floor/rate-floor.defaults'
  );
  const { mondayOfWeek } = await import('../src/modules/rate-floor/rate-floor.fuel');

  const existing = await prisma.fuelIndex.findFirst({ select: { id: true } });
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`Fuel index already present (${existing.id})`);
    return;
  }

  const row = await prisma.fuelIndex.create({
    data: {
      weekStart: mondayOfWeek(),
      dieselCpl: DEFAULT_RATE_FLOOR_VERSION_PARAMS.referenceDieselCpl,
      note: 'Seed: July 2026 national average retail reference (211.4 c/L)',
    },
  });
  // eslint-disable-next-line no-console
  console.log(`Seeded fuel index ${row.id} @ ${row.dieselCpl} c/L`);
}

async function main() {
  await seedSuperAdmin();
  const vic = await seedRegions();
  await seedVehicleClasses();
  await seedRateFloorVersion();
  await seedFuelIndex();
  await seedPublicHolidays();
  await seedScopedAdmins(vic.id);
  const { senderCompanyId, carrierCompanyId } = await seedMarketplaceUsers(vic.id);
  await seedPolicy();
  await seedPilotJobAndTrip(vic.id, carrierCompanyId, senderCompanyId);
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
