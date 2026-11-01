import { AuditController } from './audit.controller';
import { JobsController } from '../jobs/jobs.controller';
import { SettlementsController } from '../settlements/settlements.controller';
import { NotificationsController } from '../notifications/notifications.controller';

describe('Thin controller status / meta endpoints', () => {
  it('AuditController.status returns M0 scaffold', () => {
    const controller = new AuditController();
    expect(controller.status()).toEqual({
      module: 'audit',
      status: 'ready',
      milestone: 'M0',
    });
  });

  it('JobsController.status + vehicleMeta + recommend', async () => {
    const jobsService = {
      getVehicleClassesMeta: jest.fn().mockResolvedValue({
        classes: [{ code: 'UTE', rank: 1 }],
        ranks: { UTE: 1 },
      }),
      getActiveVehicleClasses: jest.fn().mockResolvedValue([
        {
          code: 'UTE',
          rank: 1,
          maxChargeableWeightKg: 1000,
          maxLengthCm: 240,
          maxWidthCm: 180,
          maxHeightCm: 150,
        },
      ]),
    };
    const controller = new JobsController(jobsService as never);
    expect(controller.status()).toEqual({
      module: 'jobs',
      status: 'ready',
      milestone: 'M6',
    });
    const meta = await controller.vehicleMeta();
    expect(meta.classes.length).toBeGreaterThan(0);
    expect(meta.ranks).toBeDefined();
    const rec = await controller.recommend({
      deadWeightKg: 500,
      lengthCm: 200,
      widthCm: 100,
      heightCm: 100,
    });
    expect(rec.chargeableWeightKg).toBeGreaterThan(0);
    expect(rec.recommendedVehicleClass).toBeTruthy();
  });

  it('SettlementsController status scaffold + NotificationsController constructs', () => {
    expect(new SettlementsController().status()).toMatchObject({
      module: 'settlements',
      status: 'scaffold',
      implemented: false,
    });
    const inbox = {
      listForPrincipal: jest.fn(),
      unreadCount: jest.fn(),
      markRead: jest.fn(),
      markAllRead: jest.fn(),
    };
    expect(new NotificationsController(inbox as never)).toBeInstanceOf(
      NotificationsController,
    );
  });
});
