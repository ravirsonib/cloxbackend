import {
  PrismaClient,
  AdminRole,
  AdminScopeType,
  CompanyStatus,
  CompanyType,
  PlatformRole,
  SenderAccountType,
  UserStatus,
} from '@prisma/client';

const prisma = new PrismaClient();

const AU_REGIONS: Array<{ code: string; name: string; enabled: boolean }> = [
  { code: 'VIC', name: 'Victoria', enabled: true },
  { code: 'NSW', name: 'New South Wales', enabled: false },
  { code: 'QLD', name: 'Queensland', enabled: false },
  { code: 'SA', name: 'South Australia', enabled: false },
  { code: 'WA', name: 'Western Australia', enabled: false },
  { code: 'TAS', name: 'Tasmania', enabled: false },
  { code: 'NT', name: 'Northern Territory', enabled: false },
  { code: 'ACT', name: 'Australian Capital Territory', enabled: false },
];

async function seedRegions() {
  for (const region of AU_REGIONS) {
    await prisma.region.upsert({
      where: { code: region.code },
      update: { name: region.name, enabled: region.enabled },
      create: region,
    });
  }

  const vic = await prisma.region.findUniqueOrThrow({ where: { code: 'VIC' } });
  await prisma.localTerritory.upsert({
    where: {
      regionId_code: { regionId: vic.id, code: 'MEL' },
    },
    update: { name: 'Melbourne Metro', enabled: true },
    create: {
      regionId: vic.id,
      code: 'MEL',
      name: 'Melbourne Metro',
      enabled: true,
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded regions (VIC enabled=${vic.enabled ? 'yes' : 'no'})`);
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
}

async function main() {
  await seedSuperAdmin();
  const vic = await seedRegions();
  await seedScopedAdmins(vic.id);
  await seedMarketplaceUsers(vic.id);
  await seedPolicy();
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
