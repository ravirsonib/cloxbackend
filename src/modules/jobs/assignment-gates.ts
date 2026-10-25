import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ComplianceDocStatus,
  ComplianceDocType,
  DriverStatus,
  type PrismaClient,
} from '@prisma/client';
import { licenceCoversVehicleClass } from './job-pricing.util';

/** Uploaded (or further) — not pending intent, rejected, or expired. */
export const USABLE_COMPLIANCE_DOC_STATUSES: ComplianceDocStatus[] = [
  ComplianceDocStatus.UPLOADED,
  ComplianceDocStatus.UNDER_REVIEW,
  ComplianceDocStatus.APPROVED,
];

export type DriverAssignmentFields = {
  id: string;
  status: DriverStatus;
  licenceClass: string | null;
  licenceExpiry: Date | null;
  nhvrAcknowledgedAt: Date | null;
};

export type AssignmentGateFailure = {
  ok: false;
  code: string;
  message: string;
};

export type AssignmentGateOk = { ok: true };

export type AssignmentGateResult = AssignmentGateOk | AssignmentGateFailure;

type PrismaDocClient = Pick<PrismaClient, 'complianceDocument'>;

export function evaluateDriverLicenceFields(
  driver: DriverAssignmentFields,
  vehicleClass: string | null | undefined,
  now: Date = new Date(),
): AssignmentGateResult {
  if (driver.status !== DriverStatus.ACTIVE) {
    return {
      ok: false,
      code: 'DRIVER_NOT_ACTIVE',
      message: 'Active driver required',
    };
  }
  if (!driver.licenceExpiry || driver.licenceExpiry <= now) {
    return {
      ok: false,
      code: 'LICENCE_EXPIRED',
      message: 'Driver licence expired or missing expiry',
    };
  }
  if (!driver.nhvrAcknowledgedAt) {
    return {
      ok: false,
      code: 'NHVR_REQUIRED',
      message: 'Driver NHVR acknowledgement required',
    };
  }
  if (!licenceCoversVehicleClass(driver.licenceClass, vehicleClass)) {
    return {
      ok: false,
      code: 'LICENCE_CLASS_MISMATCH',
      message: `Driver licence ${driver.licenceClass ?? 'none'} does not cover vehicle class ${vehicleClass}`,
    };
  }
  return { ok: true };
}

export async function hasUsableDriverLicenceDocument(
  prisma: PrismaDocClient,
  driverId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!prisma.complianceDocument?.findFirst) return false;
  const doc = await prisma.complianceDocument.findFirst({
    where: {
      driverId,
      docType: ComplianceDocType.DRIVER_LICENCE,
      status: { in: USABLE_COMPLIANCE_DOC_STATUSES },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true },
  });
  return Boolean(doc);
}

export async function hasUsableVehicleRwcDocument(
  prisma: PrismaDocClient,
  vehicleId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!prisma.complianceDocument?.findFirst) return false;
  const doc = await prisma.complianceDocument.findFirst({
    where: {
      vehicleId,
      docType: ComplianceDocType.RWC,
      status: { in: USABLE_COMPLIANCE_DOC_STATUSES },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true },
  });
  return Boolean(doc);
}

export async function evaluateAssignmentCompliance(
  prisma: PrismaDocClient,
  params: {
    driver: DriverAssignmentFields;
    vehicleId: string | null | undefined;
    vehicleClass: string | null | undefined;
  },
  now: Date = new Date(),
): Promise<AssignmentGateResult> {
  const licenceFields = evaluateDriverLicenceFields(
    params.driver,
    params.vehicleClass,
    now,
  );
  if (!licenceFields.ok) return licenceFields;

  const hasLicenceDoc = await hasUsableDriverLicenceDocument(
    prisma,
    params.driver.id,
    now,
  );
  if (!hasLicenceDoc) {
    return {
      ok: false,
      code: 'DRIVER_LICENCE_DOC_REQUIRED',
      message: 'Driver licence document upload required',
    };
  }

  if (params.vehicleId) {
    const hasRwc = await hasUsableVehicleRwcDocument(prisma, params.vehicleId, now);
    if (!hasRwc) {
      return {
        ok: false,
        code: 'VEHICLE_RWC_REQUIRED',
        message: 'Vehicle roadworthy certificate (RWC) required',
      };
    }
  }

  return { ok: true };
}

export function throwAssignmentGate(
  failure: AssignmentGateFailure,
  mode: 'badRequest' | 'forbidden' = 'badRequest',
): never {
  const body = { message: failure.message, code: failure.code };
  if (mode === 'forbidden') {
    throw new ForbiddenException(body);
  }
  throw new BadRequestException(body);
}

export async function assertAssignmentCompliance(
  prisma: PrismaDocClient,
  params: {
    driver: DriverAssignmentFields;
    vehicleId: string | null | undefined;
    vehicleClass: string | null | undefined;
  },
  mode: 'badRequest' | 'forbidden' = 'badRequest',
  now: Date = new Date(),
): Promise<void> {
  const result = await evaluateAssignmentCompliance(prisma, params, now);
  if (!result.ok) throwAssignmentGate(result, mode);
}
