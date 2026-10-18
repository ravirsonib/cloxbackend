import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
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
import { ComplianceDocStatus } from '@prisma/client';
import type { AppEnv } from '../../config/env.validation';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import {
  AuditAction,
  AdminRole,
  ComplianceDocType,
  type ConfirmDocumentInput,
  type CreateUploadIntentInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../../common/services/scope.service';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
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

  /** Local BDE must intersect company via job origin territory or home-region territory. */
  private async assertAdminTerritoryForCompany(
    principal: AuthenticatedPrincipal,
    company: { id: string; homeRegionId: string | null },
  ) {
    if (principal.role !== AdminRole.LOCAL_BDE) return;
    const allowed = this.scope.allowedTerritoryCodes(principal);
    if (allowed === null) return;
    if (allowed.length < 1) {
      throw new ForbiddenException('Local BDE has no territory scope');
    }

    const linkedJob = await this.prisma.job.findFirst({
      where: {
        OR: [
          { senderCompanyId: company.id },
          { assignment: { carrierCompanyId: company.id } },
        ],
        originTerritory: { code: { in: allowed } },
      },
      include: { originTerritory: true },
    });
    if (linkedJob?.originTerritory?.code) {
      this.scope.assertTerritoryAccess(principal, linkedJob.originTerritory.code);
      return;
    }

    if (!company.homeRegionId) {
      throw new ForbiddenException('Company has no territory assignment — Super/State only');
    }
    const territory = await this.prisma.localTerritory.findFirst({
      where: {
        regionId: company.homeRegionId,
        code: { in: allowed },
        enabled: true,
      },
    });
    if (!territory) {
      throw new ForbiddenException('Outside admin scope (territory)');
    }
    this.scope.assertTerritoryAccess(principal, territory.code);
  }

  /** Drivers may only upload their own licence docs — not company KYB packs. */
  private assertUploadRoleAllowed(
    principal: AuthenticatedPrincipal,
    input: { docType: string },
  ) {
    if (principal.kind === 'admin') return;
    if (principal.role === 'DRIVER') {
      const allowed: string[] = [
        ComplianceDocType.DRIVER_LICENCE,
        ComplianceDocType.SELFIE,
        ComplianceDocType.GOVERNMENT_ID,
        ComplianceDocType.NHVR,
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

  private assertDocActionAllowed(
    principal: AuthenticatedPrincipal,
    doc: { docType: string; driverId?: string | null },
  ) {
    this.assertUploadRoleAllowed(principal, { docType: doc.docType });
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

    await this.assertCompanyAccess(principal, input.companyId);
    this.assertUploadRoleAllowed(principal, input);
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
    this.assertDocActionAllowed(principal, doc);
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
    this.assertDocActionAllowed(principal, doc);
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

    return {
      id: updated.id,
      status: updated.status,
      contentHash: updated.contentHash,
      mimeType: updated.mimeType,
      sizeBytes: updated.sizeBytes,
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
    await this.assertCompanyAccess(principal, doc.companyId);
    this.assertDocActionAllowed(principal, doc);
    await this.assertDriverOwnsDoc(principal, doc);
    return {
      id: doc.id,
      companyId: doc.companyId,
      docType: doc.docType,
      status: doc.status,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      originalFilename: doc.originalFilename,
      contentHash: doc.contentHash,
      expiresAt: doc.expiresAt,
      createdAt: doc.createdAt,
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
