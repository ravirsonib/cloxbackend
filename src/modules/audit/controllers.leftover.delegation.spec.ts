import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { DocumentsController } from '../documents/documents.controller';
import { DriverController } from '../driver/driver.controller';
import { GeolocationController } from '../geolocation/geolocation.controller';
import { IdentityController } from '../identity/identity.controller';
import { LeadsController } from '../leads/leads.controller';
import { MatchingController } from '../matching/matching.controller';
import { OpsController } from '../ops/ops.controller';
import { SenderController } from '../sender/sender.controller';

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

describe('Controller delegation leftovers (sender/driver/docs/ops/matching/leads)', () => {
  it('SenderController delegates register / onboarding / payment', async () => {
    const sender = {
      register: jest.fn().mockResolvedValue({ id: 'co' }),
      getOnboarding: jest.fn().mockResolvedValue({ step: 1 }),
      updateProfile: jest.fn().mockResolvedValue({ ok: true }),
      submitVerification: jest.fn().mockResolvedValue({ id: 'case' }),
      createPaymentSetup: jest.fn().mockResolvedValue({ clientSecret: 'cs' }),
      confirmPayment: jest.fn().mockResolvedValue({ ok: true }),
      getBookingEligibility: jest.fn().mockResolvedValue({ canBook: true }),
    };
    const c = new SenderController(sender as never);
    await expect(c.register({} as never)).resolves.toEqual({ id: 'co' });
    await expect(c.onboarding(principal)).resolves.toEqual({ step: 1 });
    await expect(c.profile(principal, {} as never)).resolves.toEqual({ ok: true });
    await expect(c.submit(principal, {} as never)).resolves.toEqual({ id: 'case' });
    await expect(c.paymentSetup(principal)).resolves.toEqual({ clientSecret: 'cs' });
    await expect(c.paymentConfirm(principal, {} as never)).resolves.toEqual({
      ok: true,
    });
    await expect(c.bookingEligibility(principal)).resolves.toEqual({ canBook: true });
  });

  it('DriverController delegates invite / profile / assignability', async () => {
    const driver = {
      peekInvite: jest.fn().mockResolvedValue({ canAccept: true }),
      acceptInvite: jest.fn().mockResolvedValue({ next: 'otp_login' }),
      getOnboarding: jest.fn().mockResolvedValue({ step: 1 }),
      submitProfile: jest.fn().mockResolvedValue({ ok: true }),
      getAssignability: jest.fn().mockResolvedValue({ canBeAssigned: true }),
    };
    const c = new DriverController(driver as never);
    await expect(c.peek('tok')).resolves.toEqual({ canAccept: true });
    await expect(c.accept({} as never)).resolves.toEqual({ next: 'otp_login' });
    await expect(c.onboarding(principal)).resolves.toEqual({ step: 1 });
    await expect(c.profile(principal, {} as never)).resolves.toEqual({ ok: true });
    await expect(c.assignability(principal)).resolves.toEqual({ canBeAssigned: true });
  });

  it('DocumentsController status + intent / put / confirm / get', async () => {
    const documents = {
      createUploadIntent: jest.fn().mockResolvedValue({ id: 'd1' }),
      putContent: jest.fn().mockResolvedValue({ status: 'UPLOADED' }),
      confirm: jest.fn().mockResolvedValue({ status: 'UPLOADED' }),
      getMetadata: jest.fn().mockResolvedValue({ id: 'd1' }),
    };
    const c = new DocumentsController(documents as never);
    expect(c.status()).toMatchObject({ module: 'documents', milestone: 'M2' });
    await expect(c.createIntent(principal, {} as never)).resolves.toEqual({ id: 'd1' });
    await expect(
      c.putContent(principal, 'd1', {
        buffer: Buffer.from('x'),
        mimetype: 'application/pdf',
        size: 1,
        originalname: 'a.pdf',
      }),
    ).resolves.toEqual({ status: 'UPLOADED' });
    await expect(c.confirm(principal, 'd1', {} as never)).resolves.toEqual({
      status: 'UPLOADED',
    });
    await expect(c.getOne(principal, 'd1')).resolves.toEqual({ id: 'd1' });
  });

  it('OpsController status + provision + policy stub', async () => {
    const ops = {
      provisionAdmin: jest.fn().mockResolvedValue({ id: 'adm' }),
      publishPolicyStub: jest.fn().mockResolvedValue({ ok: true }),
    };
    const c = new OpsController(ops as never);
    expect(c.status()).toMatchObject({ module: 'ops', milestone: 'M1' });
    await expect(c.provisionAdmin(admin, {} as never)).resolves.toEqual({ id: 'adm' });
    await expect(c.publishPolicy(admin)).resolves.toEqual({ ok: true });
  });

  it('MatchingController status + board + bid', async () => {
    const matching = {
      listBoard: jest.fn().mockResolvedValue({ items: [] }),
      submitProposal: jest.fn().mockResolvedValue({ id: 'p1' }),
    };
    const c = new MatchingController(matching as never);
    expect(c.status()).toMatchObject({ module: 'matching', milestone: 'M6' });
    await expect(c.board(principal)).resolves.toEqual({ items: [] });
    await expect(c.placeBid(principal, {} as never)).resolves.toEqual({ id: 'p1' });
  });

  it('LeadsController registry / eoi / investor with req.ip', async () => {
    const leads = {
      createRegistryLead: jest.fn().mockResolvedValue({ id: 'L1' }),
      createEoiLead: jest.fn().mockResolvedValue({ id: 'L2' }),
      createInvestorLead: jest.fn().mockResolvedValue({ id: 'L3' }),
    };
    const c = new LeadsController(leads as never);
    const req = { ip: '10.0.0.1', socket: { remoteAddress: '10.0.0.2' } };
    await expect(c.createRegistry({} as never, req as never)).resolves.toEqual({
      id: 'L1',
    });
    expect(leads.createRegistryLead).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ ip: '10.0.0.1' }),
    );
    await expect(c.createEoi({} as never, req as never)).resolves.toEqual({ id: 'L2' });
    await expect(c.createInvestor({} as never, req as never)).resolves.toEqual({
      id: 'L3',
    });
  });

  it('LeadsController falls back to socket.remoteAddress when ip missing', async () => {
    const leads = {
      createRegistryLead: jest.fn().mockResolvedValue({ id: 'L1' }),
      createEoiLead: jest.fn().mockResolvedValue({ id: 'L2' }),
      createInvestorLead: jest.fn().mockResolvedValue({ id: 'L3' }),
    };
    const c = new LeadsController(leads as never);
    const req = {
      ip: undefined,
      socket: { remoteAddress: '127.0.0.1' },
    };
    await c.createRegistry({} as never, req as never);
    await c.createEoi({} as never, req as never);
    await c.createInvestor({} as never, req as never);
    expect(leads.createRegistryLead).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ ip: '127.0.0.1' }),
    );
    expect(leads.createEoiLead).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ ip: '127.0.0.1' }),
    );
    expect(leads.createInvestorLead).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ ip: '127.0.0.1' }),
    );
  });

  it('IdentityController + GeolocationController status scaffolds', async () => {
    const identity = { getMe: jest.fn().mockResolvedValue({ id: 'p1' }) };
    const idCtrl = new IdentityController(identity as never);
    expect(idCtrl.status()).toMatchObject({ module: 'identity', milestone: 'M1' });
    await expect(idCtrl.me(principal)).resolves.toEqual({ id: 'p1' });

    const geo = new GeolocationController();
    expect(geo.status()).toMatchObject({
      module: 'geolocation',
      status: 'scaffold',
      implemented: false,
    });
  });
});
