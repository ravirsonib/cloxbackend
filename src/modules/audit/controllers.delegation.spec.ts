import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AdminController } from '../admin/admin.controller';
import { AuthController } from '../auth/auth.controller';
import { CarrierController } from '../carrier/carrier.controller';
import { ComplianceController } from '../compliance/compliance.controller';
import { PaymentsController } from '../payments/payments.controller';
import { TripsController } from '../trips/trips.controller';

const principal: AuthenticatedPrincipal = {
  id: 'p1',
  email: 'user@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const admin: AuthenticatedPrincipal = {
  id: 'a1',
  email: 'admin@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

describe('Controller delegation leftovers', () => {
  it('AdminController delegates dashboard / leads / audit', async () => {
    const adminService = {
      getDashboardStats: jest.fn().mockResolvedValue({ ok: 1 }),
      exportLeadsCsv: jest.fn().mockResolvedValue('csv'),
      listLeads: jest.fn().mockResolvedValue({ items: [] }),
      getLead: jest.fn().mockResolvedValue({ id: 'L1' }),
      updateLead: jest.fn().mockResolvedValue({ id: 'L1' }),
      addNote: jest.fn().mockResolvedValue({ id: 'N1' }),
      listAudit: jest.fn().mockResolvedValue({ items: [] }),
    };
    const c = new AdminController(adminService as never);
    await expect(c.getDashboardStats()).resolves.toEqual({ ok: 1 });
    await expect(c.exportLeads({} as never)).resolves.toBe('csv');
    await expect(c.listLeads({} as never)).resolves.toEqual({ items: [] });
    await expect(c.getLead('L1')).resolves.toEqual({ id: 'L1' });
    await expect(c.updateLead('L1', {} as never, admin as never)).resolves.toEqual({
      id: 'L1',
    });
    await expect(c.addNote('L1', {} as never, admin as never)).resolves.toEqual({
      id: 'N1',
    });
    await expect(c.listAudit({} as never)).resolves.toEqual({ items: [] });
  });

  it('AuthController delegates OTP / sessions / step-up', async () => {
    const authService = {
      requestOtp: jest.fn().mockResolvedValue({ ok: true }),
      verifyOtp: jest.fn().mockResolvedValue({ accessToken: 'a' }),
      refresh: jest.fn().mockResolvedValue({ accessToken: 'a' }),
      logout: jest.fn().mockResolvedValue({ ok: true }),
      listSessions: jest.fn().mockResolvedValue([]),
      revokeSession: jest.fn().mockResolvedValue({ ok: true }),
      requestStepUp: jest.fn().mockResolvedValue({ ok: true }),
      verifyStepUp: jest.fn().mockResolvedValue({ token: 's' }),
    };
    const c = new AuthController(authService as never);
    await expect(c.requestOtp({} as never)).resolves.toEqual({ ok: true });
    await expect(c.verifyOtp({} as never, 'ua', '1.1.1.1')).resolves.toEqual({
      accessToken: 'a',
    });
    expect(authService.verifyOtp).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ userAgent: 'ua', ipHash: expect.any(String) }),
    );
    await expect(c.verifyOtp({} as never, undefined, undefined)).resolves.toEqual({
      accessToken: 'a',
    });
    expect(authService.verifyOtp).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ userAgent: undefined, ipHash: undefined }),
    );
    await expect(c.refresh({} as never)).resolves.toEqual({ accessToken: 'a' });
    await expect(c.logout(principal, {} as never)).resolves.toEqual({ ok: true });
    await expect(c.listSessions(principal)).resolves.toEqual([]);
    await expect(c.revokeSession(principal, 'sid')).resolves.toEqual({ ok: true });
    await expect(c.requestStepUp(principal)).resolves.toEqual({ ok: true });
    await expect(c.verifyStepUp(principal, {} as never)).resolves.toEqual({
      token: 's',
    });
  });

  it('PaymentsController status + surcharge / webhook / assignment routes', async () => {
    const payments = {
      listSenderSurcharges: jest.fn().mockResolvedValue([]),
      paySurcharge: jest.fn().mockResolvedValue({ id: 's1' }),
      waiveSurcharge: jest.fn().mockResolvedValue({ id: 's1' }),
      listCarrierExceptions: jest.fn().mockResolvedValue([]),
      handleStripeWebhook: jest.fn().mockResolvedValue({ received: true }),
      getJobPaymentStatus: jest.fn().mockResolvedValue({ jobId: 'j1' }),
      listCarrierAssignments: jest.fn().mockResolvedValue([]),
      refundStub: jest.fn().mockResolvedValue({ ok: true }),
    };
    const stripe = { isMockMode: jest.fn().mockReturnValue(true) };
    const c = new PaymentsController(payments as never, stripe as never);
    expect(c.status()).toMatchObject({ module: 'payments', stripeMock: true });
    await expect(c.listSurcharges(principal)).resolves.toEqual([]);
    await expect(c.paySurcharge(principal, 's1')).resolves.toEqual({ id: 's1' });
    await expect(c.waiveSurcharge(admin, 's1')).resolves.toEqual({ id: 's1' });
    await expect(c.exceptions(principal)).resolves.toEqual([]);
    await expect(
      c.webhook({ rawBody: Buffer.from('{}') } as never, 'sig', {}),
    ).resolves.toEqual({ received: true });
    await expect(c.jobPayment(principal, 'j1')).resolves.toEqual({ jobId: 'j1' });
    await expect(c.assignments(principal)).resolves.toEqual([]);
    await expect(c.refundStub(principal, 'j1')).resolves.toEqual({ ok: true });
  });

  it('TripsController status + driver/sender routes', async () => {
    const trips = {
      listDriverTrips: jest.fn().mockResolvedValue([]),
      getSenderTracking: jest.fn().mockResolvedValue({ jobId: 'j1' }),
      startByJobId: jest.fn().mockResolvedValue({ id: 't1' }),
      getDriverTrip: jest.fn().mockResolvedValue({ id: 't1' }),
      safetyCheck: jest.fn().mockResolvedValue({ ok: true }),
      massCheck: jest.fn().mockResolvedValue({ ok: true }),
      startTrip: jest.fn().mockResolvedValue({ id: 't1' }),
      toggleBreak: jest.fn().mockResolvedValue({ ok: true }),
      postLocation: jest.fn().mockResolvedValue({ ok: true }),
    };
    const c = new TripsController(trips as never);
    expect(c.status()).toMatchObject({ module: 'trips', milestone: 'M9' });
    await expect(c.mine(principal)).resolves.toEqual([]);
    await expect(c.track(principal, 'j1')).resolves.toEqual({ jobId: 'j1' });
    await expect(c.startByJob(principal, 'j1', {} as never)).resolves.toEqual({
      id: 't1',
    });
    await expect(c.get(principal, 't1')).resolves.toEqual({ id: 't1' });
    await expect(c.safety(principal, 't1', {} as never)).resolves.toEqual({
      ok: true,
    });
    await expect(c.mass(principal, 't1', {} as never)).resolves.toEqual({
      ok: true,
    });
    await expect(c.start(principal, 't1', {} as never)).resolves.toEqual({
      id: 't1',
    });
    await expect(c.breakToggle(principal, 't1', {} as never)).resolves.toEqual({
      ok: true,
    });
    await expect(c.location(principal, 't1', {} as never)).resolves.toEqual({
      ok: true,
    });
  });

  it('ComplianceController status + ops case routes', async () => {
    const compliance = {
      submit: jest.fn().mockResolvedValue({ id: 'c1' }),
      listCases: jest.fn().mockResolvedValue({ items: [] }),
      getCase: jest.fn().mockResolvedValue({ id: 'c1' }),
      approve: jest.fn().mockResolvedValue({ id: 'c1' }),
      reject: jest.fn().mockResolvedValue({ id: 'c1' }),
      requestInfo: jest.fn().mockResolvedValue({ id: 'c1' }),
      escalate: jest.fn().mockResolvedValue({ id: 'c1' }),
    };
    const abr = { lookupAbn: jest.fn().mockResolvedValue({ abn: '1' }) };
    const c = new ComplianceController(compliance as never, abr as never);
    expect(c.status()).toMatchObject({ module: 'compliance' });
    await expect(c.submit(principal, {} as never)).resolves.toEqual({ id: 'c1' });
    await expect(c.abrLookup({ abn: '51824753556' } as never)).resolves.toEqual({
      abn: '1',
    });
    await expect(c.listCases(admin, {} as never)).resolves.toEqual({ items: [] });
    await expect(c.getCase(admin, 'c1')).resolves.toEqual({ id: 'c1' });
    await expect(c.approve(admin, 'c1', {} as never)).resolves.toEqual({ id: 'c1' });
    await expect(c.reject(admin, 'c1', {} as never)).resolves.toEqual({ id: 'c1' });
    await expect(c.requestInfo(admin, 'c1', {} as never)).resolves.toEqual({
      id: 'c1',
    });
    await expect(c.escalate(admin, 'c1', {} as never)).resolves.toEqual({
      id: 'c1',
    });
  });

  it('CarrierController delegates onboarding + bid routes', async () => {
    const carrier = {
      register: jest.fn().mockResolvedValue({ id: 'co' }),
      getOnboarding: jest.fn().mockResolvedValue({ step: 1 }),
      updateProfile: jest.fn().mockResolvedValue({ ok: true }),
      createConnectOnboarding: jest.fn().mockResolvedValue({ url: 'u' }),
      confirmConnect: jest.fn().mockResolvedValue({ ok: true }),
      addVehicle: jest.fn().mockResolvedValue({ id: 'v1' }),
      inviteDriver: jest.fn().mockResolvedValue({ id: 'd1' }),
      resendDriverInvite: jest.fn().mockResolvedValue({ ok: true }),
      updateCapabilities: jest.fn().mockResolvedValue({ ok: true }),
      submitVerification: jest.fn().mockResolvedValue({ id: 'case' }),
      getBidEligibility: jest.fn().mockResolvedValue({ canBid: true }),
    };
    const matching = {
      submitProposal: jest.fn().mockResolvedValue({ id: 'p1' }),
    };
    const c = new CarrierController(carrier as never, matching as never);
    await expect(c.register({} as never)).resolves.toEqual({ id: 'co' });
    await expect(c.onboarding(principal)).resolves.toEqual({ step: 1 });
    await expect(c.profile(principal, {} as never)).resolves.toEqual({ ok: true });
    await expect(c.connectSetup(principal)).resolves.toEqual({ url: 'u' });
    await expect(c.connectConfirm(principal)).resolves.toEqual({ ok: true });
    await expect(c.addVehicle(principal, {} as never)).resolves.toEqual({ id: 'v1' });
    await expect(c.inviteDriver(principal, {} as never)).resolves.toEqual({
      id: 'd1',
    });
    await expect(c.resendInvite(principal, {} as never)).resolves.toEqual({
      ok: true,
    });
    await expect(c.capabilities(principal, {} as never)).resolves.toEqual({
      ok: true,
    });
    await expect(c.submit(principal, {} as never)).resolves.toEqual({ id: 'case' });
    await expect(c.bidEligibility(principal)).resolves.toEqual({ canBid: true });
    await expect(c.bid(principal, {} as never)).resolves.toEqual({ id: 'p1' });
  });
});
