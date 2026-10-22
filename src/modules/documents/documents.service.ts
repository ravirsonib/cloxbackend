import { createHash, randomUUID } from 'crypto';
import { createReadStream, existsSync, mkdirSync, type ReadStream } from 'fs';
import { access, mkdir, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminUserStatus,
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
} from '@prisma/client';
import type { AppEnv } from '../../config/env.validation';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import {
  AuditAction,
  AdminRole,
  ComplianceDocType,
  type ConfirmDocumentInput,
  type CreateUploadIntentInput,
} from '../../shared/types';
import { AttributionService } from '../../common/services/attribution.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../../common/services/scope.service';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const ADMIN_PARTNER_DOC_TYPES: readonly string[] = [
  ComplianceDocType.ABN_EXTRACT,
  ComplianceDocType.GOVERNMENT_ID,
  ComplianceDocType.MASTER_ADMIN_AGREEMENT,
  ComplianceDocType.OTHER,
];

const PARTNER_ONBOARDING_STATUSES: readonly AdminUserStatus[] = [
  AdminUserStatus.INVITED,
  AdminUserStatus.PENDING_DOCS,
  AdminUserStatus.PENDING_REVIEW,
];

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly attribution: AttributionService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private storageRoot() {
    return resolve(this.config.get('STORAGE_LOCAL_DIR', { infer: true }));
  }

  private absolutePath(storageKey: string) {
    const root = this.storageRoot();
    const full = resolve(root, storageKey);
    if (!full.startsWith(root)) {
      throw new BadRequestException('Invalid storage key');
    }
    return full;
  }

  private async assertCompanyAccess(
    principal: AuthenticatedPrincipal,
    companyId: string,
  ) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { homeRegion: true },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }

    if (principal.kind === 'admin') {
      const self = await this.prisma.adminUser.findUnique({
        where: { id: principal.id },
        select: { id: true, companyId: true, status: true, role: true },
      });
      if (
        self?.companyId === companyId &&
        company.type === CompanyType.ADMIN_PARTNER &&
        (self.role === AdminRole.STATE_MASTER || self.role === AdminRole.LOCAL_BDE) &&
        PARTNER_ONBOARDING_STATUSES.includes(self.status)
      ) {
        return company;
      }

      if (
        principal.adminStatus &&
        principal.adminStatus !== AdminUserStatus.ACTIVE &&
        (principal.role === AdminRole.STATE_MASTER || principal.role === AdminRole.LOCAL_BDE)
      ) {
        throw new ForbiddenException(
          'Ops document access requires Super Admin approval',
        );
      }

      const regionCode = company.homeRegion?.code;
      if (regionCode) {
        this.scope.assertRegionAccess(principal, regionCode);
      } else if (principal.role !== AdminRole.SUPER_ADMIN) {
        throw new ForbiddenException('Company has no region — Super only');
      }
      await this.assertAdminTerritoryForCompany(principal, company);
      return company;
    }

    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user || user.companyId !== companyId) {
      throw new ForbiddenException('Not a member of this company');
    }
    return company;
  }

  /**
   * Local BDE: book-of-business isolation (referredBy = self).
   * Same territory alone is not enough when multiple Locals share a territory.
   */
  private assertAdminTerritoryForCompany(
    principal: AuthenticatedPrincipal,
    company: { referredByAdminUserId?: string | null },
  ) {
    if (principal.role !== AdminRole.LOCAL_BDE) return;
    this.attribution.assertLocalOwnsCompany(principal, {
      referredByAdminUserId: company.referredByAdminUserId ?? null,
    });
  }

  /** Drivers may only upload their own licence docs — not company KYB packs. */
  private assertUploadRoleAllowed(
    principal: AuthenticatedPrincipal,
    input: { docType: string },
    companyType?: CompanyType,
  ) {
    if (principal.kind === 'admin') {
      if (companyType === CompanyType.ADMIN_PARTNER) {
        if (!ADMIN_PARTNER_DOC_TYPES.includes(input.docType)) {
          throw new ForbiddenException(
            'Admin partners may only upload KYB pack documents (ABN, ID, Master Admin Agreement)',
          );
        }
      }
      return;
    }
    if (principal.role === 'DRIVER') {
      const allowed: string[] = [
        ComplianceDocType.DRIVER_LICENCE,
        ComplianceDocType.SELFIE,
        ComplianceDocType.GOVERNMENT_ID,
        ComplianceDocType.NHVR,
        /** Evidence for trip exceptions (breakdown photo). */
        ComplianceDocType.OTHER,
      ];
      if (!allowed.includes(input.docType)) {
        throw new ForbiddenException('Drivers cannot upload company KYB documents');
      }
      return;
    }
    if (
      principal.role !== 'SENDER' &&
      principal.role !== 'TRANSPORT_COMPANY'
    ) {
      throw new ForbiddenException('Insufficient role for document upload');
    }
  }

  private async assertDriverOwnsDoc(
    principal: AuthenticatedPrincipal,
    doc: { driverId: string | null; docType: string },
  ) {
    if (principal.kind !== 'user' || principal.role !== 'DRIVER') return;
    const self = await this.prisma.driver.findUnique({
      where: { userId: principal.id },
      select: { id: true },
    });
    if (!self) {
      throw new ForbiddenException('Driver profile required');
    }
    if (doc.driverId !== self.id) {
      throw new ForbiddenException('Cannot access another driver document');
    }
  }

  private async assertDocActionAllowed(
    principal: AuthenticatedPrincipal,
    doc: { docType: string; driverId?: string | null; companyId?: string | null },
  ) {
    let companyType: CompanyType | undefined;
    if (doc.companyId) {
      const company = await this.prisma.company.findUnique({
        where: { id: doc.companyId },
        select: { type: true },
      });
      companyType = company?.type;
    }
    this.assertUploadRoleAllowed(principal, { docType: doc.docType }, companyType);
  }

  /** Company members (carrier/sender) and Ops may read; drivers only their own allowed types. */
  private async assertDocReadAllowed(
    principal: AuthenticatedPrincipal,
    doc: { companyId: string | null; driverId: string | null; docType: string },
  ) {
    if (!doc.companyId) {
      throw new NotFoundException('Document not found');
    }
    await this.assertCompanyAccess(principal, doc.companyId);
    await this.assertDriverOwnsDoc(principal, doc);
    if (principal.kind === 'user' && principal.role === 'DRIVER') {
      this.assertUploadRoleAllowed(principal, { docType: doc.docType });
    }
  }

  private mapDocumentMeta(
    doc: {
      id: string;
      companyId: string | null;
      driverId: string | null;
      vehicleId: string | null;
      docType: string;
      status: ComplianceDocStatus;
      mimeType: string | null;
      sizeBytes: number | null;
      originalFilename: string | null;
      contentHash: string | null;
      expiresAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    links?: {
      vehicleRegistration?: string | null;
      vehicleLabel?: string | null;
      driverName?: string | null;
      driverEmail?: string | null;
    },
  ) {
    const ownerKind = doc.vehicleId
      ? ('fleet' as const)
      : doc.driverId
        ? ('driver' as const)
        : ('company' as const);
    return {
      id: doc.id,
      companyId: doc.companyId,
      driverId: doc.driverId,
      vehicleId: doc.vehicleId,
      docType: doc.docType,
      status: doc.status,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      originalFilename: doc.originalFilename,
      contentHash: doc.contentHash,
      expiresAt: doc.expiresAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      ownerKind,
      vehicleRegistration: links?.vehicleRegistration ?? null,
      vehicleLabel: links?.vehicleLabel ?? null,
      driverName: links?.driverName ?? null,
      driverEmail: links?.driverEmail ?? null,
    };
  }

  private async resolveLinkedIds(
    principal: AuthenticatedPrincipal,
    input: CreateUploadIntentInput,
  ): Promise<{ vehicleId: string | null; driverId: string | null }> {
    let vehicleId = input.vehicleId ?? null;
    let driverId = input.driverId ?? null;

    if (vehicleId) {
      const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
      if (!vehicle || vehicle.companyId !== input.companyId) {
        throw new BadRequestException('vehicleId must belong to companyId');
      }
    }

    if (driverId) {
      const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver || driver.companyId !== input.companyId) {
        throw new BadRequestException('driverId must belong to companyId');
      }
    }

    if (principal.kind === 'user' && principal.role === 'DRIVER') {
      const self = await this.prisma.driver.findUnique({
        where: { userId: principal.id },
        select: { id: true, companyId: true },
      });
      if (!self || self.companyId !== input.companyId) {
        throw new ForbiddenException('Driver not in company');
      }
      if (driverId && driverId !== self.id) {
        throw new ForbiddenException('Drivers may only attach their own driverId');
      }
      driverId = self.id;
      if (vehicleId) {
        throw new ForbiddenException('Drivers cannot attach vehicleId');
      }
    }

    if (input.docType === ComplianceDocType.RWC && !vehicleId) {
      // Company-level RWC allowed; expiry watchdog suspends entire fleet.
      // Prefer per-vehicle when UI supplies vehicleId.
    }

    return { vehicleId, driverId };
  }

  async createUploadIntent(
    principal: AuthenticatedPrincipal,
    input: CreateUploadIntentInput,
  ) {
    this.ensureDatabase();

    if (!ALLOWED_MIME.has(input.mimeType)) {
      throw new BadRequestException('Unsupported mime type');
    }
    if (input.sizeBytes > 10 * 1024 * 1024) {
      throw new BadRequestException('File exceeds 10MB limit');
    }

    const company = await this.assertCompanyAccess(principal, input.companyId);
    this.assertUploadRoleAllowed(principal, input, company.type);
    const linked = await this.resolveLinkedIds(principal, input);

    const documentId = randomUUID();
    const ext =
      input.mimeType === 'application/pdf'
        ? 'pdf'
        : input.mimeType === 'image/png'
          ? 'png'
          : input.mimeType === 'image/webp'
            ? 'webp'
            : 'jpg';
    const storageKey = join(input.companyId, `${documentId}.${ext}`).replace(/\\/g, '/');

    const doc = await this.prisma.complianceDocument.create({
      data: {
        id: documentId,
        companyId: input.companyId,
        vehicleId: linked.vehicleId,
        driverId: linked.driverId,
        docType: input.docType,
        status: ComplianceDocStatus.UPLOAD_PENDING,
        storageKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        originalFilename: input.originalFilename,
        uploadedByUserId: principal.kind === 'user' ? principal.id : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DOC_UPLOAD_INTENT,
      actorAdminId: principal.kind === 'admin' ? principal.id : undefined,
      actorUserId: principal.kind === 'user' ? principal.id : undefined,
      entityType: 'ComplianceDocument',
      entityId: doc.id,
      metadata: { docType: doc.docType, mimeType: doc.mimeType },
    });

    const apiPrefix = this.config.get('API_PREFIX', { infer: true });
    return {
      id: doc.id,
      status: doc.status,
      storageKey: doc.storageKey,
      /** Multipart field name `file` — local stand-in for signed URL. */
      uploadUrl: `/${apiPrefix}/documents/${doc.id}/content`,
      uploadField: 'file',
      maxBytes: 10 * 1024 * 1024,
      allowedMimeTypes: [...ALLOWED_MIME],
    };
  }

  async putContent(
    principal: AuthenticatedPrincipal,
    documentId: string,
    file: { buffer: Buffer; mimetype: string; size: number; originalname: string } | undefined,
  ) {
    this.ensureDatabase();

    if (!file?.buffer?.length) {
      throw new BadRequestException('Missing file upload (multipart field "file")');
    }

    const doc = await this.prisma.complianceDocument.findUnique({
      where: { id: documentId },
    });
    if (!doc || !doc.companyId || !doc.storageKey) {
      throw new NotFoundException('Document not found');
    }
    if (doc.status !== ComplianceDocStatus.UPLOAD_PENDING) {
      throw new BadRequestException('Document is not awaiting upload');
    }

    await this.assertCompanyAccess(principal, doc.companyId);
    await this.assertDocActionAllowed(principal, doc);
    await this.assertDriverOwnsDoc(principal, doc);

    if (doc.mimeType && file.mimetype !== doc.mimeType) {
      throw new BadRequestException('Content-Type does not match upload intent');
    }
    const maxBytes = doc.sizeBytes ?? 10 * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new BadRequestException('Upload exceeded declared size');
    }

    const fullPath = this.absolutePath(doc.storageKey);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.buffer);

    const contentHash = createHash('sha256').update(file.buffer).digest('hex');

    const updated = await this.prisma.complianceDocument.update({
      where: { id: doc.id },
      data: {
        status: ComplianceDocStatus.UPLOADED,
        contentHash,
        sizeBytes: file.size,
        originalFilename: file.originalname || doc.originalFilename,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DOC_UPLOADED,
      actorAdminId: principal.kind === 'admin' ? principal.id : undefined,
      actorUserId: principal.kind === 'user' ? principal.id : undefined,
      entityType: 'ComplianceDocument',
      entityId: updated.id,
      metadata: { contentHash, sizeBytes: file.size },
    });

    return {
      id: updated.id,
      status: updated.status,
      contentHash: updated.contentHash,
      sizeBytes: updated.sizeBytes,
    };
  }

  async confirm(
    principal: AuthenticatedPrincipal,
    documentId: string,
    input: ConfirmDocumentInput,
  ) {
    this.ensureDatabase();

    const doc = await this.prisma.complianceDocument.findUnique({
      where: { id: documentId },
    });
    if (!doc || !doc.companyId) {
      throw new NotFoundException('Document not found');
    }
    await this.assertCompanyAccess(principal, doc.companyId);
    await this.assertDocActionAllowed(principal, doc);
    await this.assertDriverOwnsDoc(principal, doc);

    if (doc.status !== ComplianceDocStatus.UPLOADED) {
      throw new BadRequestException('Document must be uploaded before confirm');
    }
    if (!doc.contentHash || doc.contentHash.toLowerCase() !== input.contentHash.toLowerCase()) {
      throw new BadRequestException('contentHash mismatch');
    }

    const updated = await this.prisma.complianceDocument.update({
      where: { id: doc.id },
      data: { status: ComplianceDocStatus.UPLOADED },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DOC_CONFIRMED,
      actorAdminId: principal.kind === 'admin' ? principal.id : undefined,
      actorUserId: principal.kind === 'user' ? principal.id : undefined,
      entityType: 'ComplianceDocument',
      entityId: updated.id,
    });

    if (
      updated.docType === ComplianceDocType.RWC &&
      updated.vehicleId &&
      updated.companyId
    ) {
      await this.attachVehicleRwcToFleetCaseIfBidEligible(updated.companyId, updated.id);
    }

    return {
      id: updated.id,
      status: updated.status,
      contentHash: updated.contentHash,
      mimeType: updated.mimeType,
      sizeBytes: updated.sizeBytes,
    };
  }

  /**
   * After KYB, new/replaced per-vehicle RWCs open (or join) CARRIER_FLEET_RWC for Ops
   * without changing company BID_ELIGIBLE. Also attaches orphan UPLOADED vehicle RWCs.
   */
  private async attachVehicleRwcToFleetCaseIfBidEligible(
    companyId: string,
    documentId: string,
  ) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, status: true, homeRegionId: true, type: true },
    });
    if (!company || company.type !== CompanyType.CARRIER) return;
    if (company.status !== CompanyStatus.BID_ELIGIBLE) return;

    let fleetCase = await this.prisma.complianceCase.findFirst({
      where: {
        companyId,
        caseType: ComplianceCaseType.CARRIER_FLEET_RWC,
        status: {
          in: [
            ComplianceCaseStatus.OPEN,
            ComplianceCaseStatus.INFO_REQUESTED,
            ComplianceCaseStatus.ESCALATED,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!fleetCase) {
      fleetCase = await this.prisma.complianceCase.create({
        data: {
          companyId,
          caseType: ComplianceCaseType.CARRIER_FLEET_RWC,
          status: ComplianceCaseStatus.OPEN,
          regionId: company.homeRegionId,
        },
      });
    } else if (fleetCase.status === ComplianceCaseStatus.INFO_REQUESTED) {
      fleetCase = await this.prisma.complianceCase.update({
        where: { id: fleetCase.id },
        data: {
          status: ComplianceCaseStatus.OPEN,
          decisionNote: null,
        },
      });
    }

    const orphanRwcs = await this.prisma.complianceDocument.findMany({
      where: {
        companyId,
        docType: ComplianceDocType.RWC,
        vehicleId: { not: null },
        status: ComplianceDocStatus.UPLOADED,
        OR: [{ caseId: null }, { id: documentId }],
      },
      select: { id: true },
    });
    const ids = [...new Set([documentId, ...orphanRwcs.map((d) => d.id)])];
    await this.prisma.complianceDocument.updateMany({
      where: { id: { in: ids } },
      data: {
        caseId: fleetCase.id,
        status: ComplianceDocStatus.UNDER_REVIEW,
      },
    });
  }

  async listDocuments(
    principal: AuthenticatedPrincipal,
    query: { companyId: string; driverId?: string },
  ) {
    this.ensureDatabase();
    await this.assertCompanyAccess(principal, query.companyId);

    let driverIdFilter: string | undefined = query.driverId;

    if (principal.kind === 'user' && principal.role === 'DRIVER') {
      const self = await this.prisma.driver.findUnique({
        where: { userId: principal.id },
        select: { id: true, companyId: true },
      });
      if (!self || self.companyId !== query.companyId) {
        throw new ForbiddenException('Driver not in company');
      }
      if (query.driverId && query.driverId !== self.id) {
        throw new ForbiddenException('Cannot list another driver document');
      }
      driverIdFilter = self.id;
    } else if (query.driverId) {
      const driver = await this.prisma.driver.findFirst({
        where: { id: query.driverId, companyId: query.companyId },
        select: { id: true },
      });
      if (!driver) {
        throw new BadRequestException('driverId must belong to companyId');
      }
    }

    const docs = await this.prisma.complianceDocument.findMany({
      where: {
        companyId: query.companyId,
        status: { not: ComplianceDocStatus.UPLOAD_PENDING },
        ...(driverIdFilter ? { driverId: driverIdFilter } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const vehicleIds = [
      ...new Set(docs.map((d) => d.vehicleId).filter((id): id is string => Boolean(id))),
    ];
    const driverIds = [
      ...new Set(docs.map((d) => d.driverId).filter((id): id is string => Boolean(id))),
    ];
    const [vehicles, drivers] = await Promise.all([
      vehicleIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; registration: string | null; label: string | null }>)
        : this.prisma.vehicle.findMany({
            where: { id: { in: vehicleIds }, companyId: query.companyId },
            select: { id: true, registration: true, label: true },
          }),
      driverIds.length === 0
        ? Promise.resolve(
            [] as Array<{
              id: string;
              user: { name: string | null; email: string };
            }>,
          )
        : this.prisma.driver.findMany({
            where: { id: { in: driverIds }, companyId: query.companyId },
            select: {
              id: true,
              user: { select: { name: true, email: true } },
            },
          }),
    ]);
    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
    const driverById = new Map(drivers.map((d) => [d.id, d]));

    return {
      items: docs.map((d) => {
        const vehicle = d.vehicleId ? vehicleById.get(d.vehicleId) : undefined;
        const driver = d.driverId ? driverById.get(d.driverId) : undefined;
        return this.mapDocumentMeta(d, {
          vehicleRegistration: vehicle?.registration ?? null,
          vehicleLabel: vehicle?.label ?? null,
          driverName: driver?.user.name ?? null,
          driverEmail: driver?.user.email ?? null,
        });
      }),
    };
  }

  async getMetadata(principal: AuthenticatedPrincipal, documentId: string) {
    this.ensureDatabase();
    const doc = await this.prisma.complianceDocument.findUnique({
      where: { id: documentId },
    });
    if (!doc || !doc.companyId) {
      throw new NotFoundException('Document not found');
    }
    await this.assertDocReadAllowed(principal, doc);
    return this.mapDocumentMeta(doc);
  }

  /**
   * Stream stored file for Ops visual review (G0-2 / G0-15) or company member access.
   * Inline Content-Disposition so PDF/images open in the browser.
   */
  async getContent(
    principal: AuthenticatedPrincipal,
    documentId: string,
  ): Promise<{ stream: ReadStream; mimeType: string; filename: string; sizeBytes: number | null }> {
    this.ensureDatabase();
    const doc = await this.prisma.complianceDocument.findUnique({
      where: { id: documentId },
    });
    if (!doc || !doc.companyId || !doc.storageKey) {
      throw new NotFoundException('Document not found');
    }
    await this.assertDocReadAllowed(principal, doc);

    if (doc.status === ComplianceDocStatus.UPLOAD_PENDING) {
      throw new BadRequestException('Document has not been uploaded yet');
    }

    const fullPath = this.absolutePath(doc.storageKey);
    try {
      await access(fullPath);
    } catch {
      throw new NotFoundException('Document file missing from storage');
    }

    const mimeType = doc.mimeType && ALLOWED_MIME.has(doc.mimeType) ? doc.mimeType : 'application/octet-stream';
    const filename = doc.originalFilename?.trim() || `${doc.docType.toLowerCase()}.bin`;

    return {
      stream: createReadStream(fullPath),
      mimeType,
      filename,
      sizeBytes: doc.sizeBytes,
    };
  }

  ensureStorageDir() {
    const root = this.storageRoot();
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
      this.logger.log(`Created local document storage at ${root}`);
    }
  }

  async openExists(storageKey: string) {
    const full = this.absolutePath(storageKey);
    await access(full);
    return full;
  }
}
