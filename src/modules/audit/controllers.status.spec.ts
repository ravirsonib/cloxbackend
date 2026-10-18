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

  it('JobsController.status + vehicleMeta + recommend', () => {
    const controller = new JobsController({} as never);
    expect(controller.status()).toEqual({
      module: 'jobs',
      status: 'ready',
      milestone: 'M6',
    });
    const meta = controller.vehicleMeta();
    expect(meta.classes.length).toBeGreaterThan(0);
    expect(meta.ranks).toBeDefined();
    const rec = controller.recommend({
      deadWeightKg: 500,
      lengthCm: 200,
      widthCm: 100,
      heightCm: 100,
    });
    expect(rec.chargeableWeightKg).toBeGreaterThan(0);
    expect(rec.recommendedVehicleClass).toBeTruthy();
  });

  it('SettlementsController + NotificationsController status scaffolds', () => {
    expect(new SettlementsController().status()).toMatchObject({
      module: 'settlements',
      status: 'scaffold',
      implemented: false,
    });
    expect(new NotificationsController().status()).toMatchObject({
      module: 'notifications',
      status: 'scaffold',
      implemented: false,
    });
  });
});
