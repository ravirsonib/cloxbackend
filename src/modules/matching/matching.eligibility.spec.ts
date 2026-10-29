import { CompanyStatus, VehicleStatus } from '@prisma/client';
import { carrierMatchesJob } from './matching.eligibility';

const baseCompany = {
  status: CompanyStatus.BID_ELIGIBLE,
  capabilities: [] as string[],
  serviceRegionCodes: ['VIC'],
  homeRegion: { code: 'VIC' },
  vehicles: [
    {
      vehicleClass: 'VAN',
      status: VehicleStatus.ACTIVE,
    },
  ],
};

const baseJob = {
  requiresDg: false,
  requiresReefer: false,
  requiresOversize: false,
  minVehicleClass: 'VAN',
  chargeableWeightKg: 100,
  originRegion: { code: 'VIC' },
};

describe('carrierMatchesJob', () => {
  it('matches when region, class, and capabilities align', () => {
    expect(carrierMatchesJob(baseCompany, baseJob)).toBe(true);
  });

  it('rejects DG jobs without DG capability', () => {
    expect(
      carrierMatchesJob(baseCompany, { ...baseJob, requiresDg: true }),
    ).toBe(false);
  });

  it('rejects when origin region is outside carrier coverage', () => {
    expect(
      carrierMatchesJob(baseCompany, {
        ...baseJob,
        originRegion: { code: 'NSW' },
      }),
    ).toBe(false);
  });

  it('rejects when no active adequate vehicle', () => {
    expect(
      carrierMatchesJob(
        {
          ...baseCompany,
          vehicles: [
            { vehicleClass: 'VAN', status: VehicleStatus.SUSPENDED },
          ],
        },
        baseJob,
      ),
    ).toBe(false);
  });
});
