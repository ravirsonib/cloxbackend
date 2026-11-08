import { CompanyStatus, VehicleStatus } from '@prisma/client';
import {
  DEFAULT_VEHICLE_CLASSES,
  isVehicleAdequateForJob,
  type VehicleClassSpec,
} from '../jobs/job-pricing.util';

export type CarrierEligibilityCompany = {
  status: CompanyStatus;
  capabilities: string[];
  serviceRegionCodes: string[];
  homeRegion: { code: string } | null;
  referredByAdminUser?: {
    scopes?: Array<{
      region?: { code: string } | null;
      localTerritory?: { region?: { code: string } | null } | null;
    }>;
  } | null;
  vehicles: Array<{ vehicleClass: string | null; status: VehicleStatus }>;
};

export type CarrierEligibilityJob = {
  requiresDg: boolean;
  requiresReefer: boolean;
  requiresOversize: boolean;
  minVehicleClass: string | null;
  chargeableWeightKg?: number | null;
  originRegion: { code: string } | null;
};

/**
 * Same rules as market board visibility: capabilities, origin region,
 * and at least one ACTIVE vehicle adequate for class/weight.
 */
export function carrierMatchesJob(
  company: CarrierEligibilityCompany,
  job: CarrierEligibilityJob,
  classes: VehicleClassSpec[] = DEFAULT_VEHICLE_CLASSES,
): boolean {
  if (job.requiresDg && !company.capabilities.includes('DG')) return false;
  if (job.requiresReefer && !company.capabilities.includes('REEFER')) return false;
  if (job.requiresOversize && !company.capabilities.includes('OVERSIZE')) return false;
  const referrerRegions =
    company.referredByAdminUser?.scopes?.flatMap((s) => [
      ...(s.region?.code ? [s.region.code] : []),
      ...(s.localTerritory?.region?.code ? [s.localTerritory.region.code] : []),
    ]) ?? [];
  const regions = new Set([
    ...company.serviceRegionCodes,
    ...(company.homeRegion?.code ? [company.homeRegion.code] : []),
    ...referrerRegions,
  ]);
  if (job.originRegion?.code && !regions.has(job.originRegion.code)) return false;
  return company.vehicles.some(
    (v) =>
      v.status === VehicleStatus.ACTIVE &&
      isVehicleAdequateForJob(
        v.vehicleClass,
        job.minVehicleClass,
        job.chargeableWeightKg,
        classes,
      ),
  );
}
