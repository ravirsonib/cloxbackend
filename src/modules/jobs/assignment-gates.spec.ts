import {
  ComplianceDocStatus,
  ComplianceDocType,
  DriverStatus,
} from '@prisma/client';
import {
  evaluateAssignmentCompliance,
  evaluateDriverLicenceFields,
} from './assignment-gates';

describe('assignment-gates', () => {
  const activeDriver = {
    id: 'drv-1',
    status: DriverStatus.ACTIVE,
    licenceClass: 'HC',
    licenceExpiry: new Date('2030-01-01T00:00:00.000Z'),
    nhvrAcknowledgedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  it('evaluateDriverLicenceFields rejects expired licence', () => {
    const result = evaluateDriverLicenceFields(
      { ...activeDriver, licenceExpiry: new Date('2020-01-01T00:00:00.000Z') },
      'SEMI',
    );
    expect(result).toMatchObject({ ok: false, code: 'LICENCE_EXPIRED' });
  });

  it('evaluateDriverLicenceFields rejects NHVR missing', () => {
    const result = evaluateDriverLicenceFields(
      { ...activeDriver, nhvrAcknowledgedAt: null },
      'SEMI',
    );
    expect(result).toMatchObject({ ok: false, code: 'NHVR_REQUIRED' });
  });

  it('evaluateDriverLicenceFields rejects class mismatch', () => {
    const result = evaluateDriverLicenceFields(
      { ...activeDriver, licenceClass: 'C' },
      'SEMI',
    );
    expect(result).toMatchObject({ ok: false, code: 'LICENCE_CLASS_MISMATCH' });
  });

  it('evaluateAssignmentCompliance requires DRIVER_LICENCE + RWC docs', async () => {
    const prisma = {
      complianceDocument: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'lic-1' })
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'lic-1' })
          .mockResolvedValueOnce({ id: 'rwc-1' }),
      },
    };

    const missingLicence = await evaluateAssignmentCompliance(prisma as never, {
      driver: activeDriver,
      vehicleId: 'veh-1',
      vehicleClass: 'SEMI',
    });
    expect(missingLicence).toMatchObject({
      ok: false,
      code: 'DRIVER_LICENCE_DOC_REQUIRED',
    });

    const missingRwc = await evaluateAssignmentCompliance(prisma as never, {
      driver: activeDriver,
      vehicleId: 'veh-1',
      vehicleClass: 'SEMI',
    });
    expect(missingRwc).toMatchObject({ ok: false, code: 'VEHICLE_RWC_REQUIRED' });

    const ok = await evaluateAssignmentCompliance(prisma as never, {
      driver: activeDriver,
      vehicleId: 'veh-1',
      vehicleClass: 'SEMI',
    });
    expect(ok).toEqual({ ok: true });
    expect(prisma.complianceDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          docType: ComplianceDocType.DRIVER_LICENCE,
          status: {
            in: [
              ComplianceDocStatus.UPLOADED,
              ComplianceDocStatus.UNDER_REVIEW,
              ComplianceDocStatus.APPROVED,
            ],
          },
        }),
      }),
    );
  });
});
