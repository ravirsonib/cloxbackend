import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AdminRole, AdminScopeType } from '@prisma/client';
import { AuditAction, type ProvisionAdminInput } from '../../shared/types';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class OpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  async provisionAdmin(actor: AuthenticatedPrincipal, input: ProvisionAdminInput) {
    this.ensureDatabase();

    const region = await this.prisma.region.findUnique({
      where: { code: input.regionCode },
    });
    if (!region) {
      throw new NotFoundException(`Unknown region ${input.regionCode}`);
    }

    let territoryId: string | null = null;
    if (input.role === AdminRole.LOCAL_BDE) {
      if (!input.territoryCode) {
        throw new BadRequestException('territoryCode required for LOCAL_BDE');
      }
      const territory = await this.prisma.localTerritory.findUnique({
        where: {
          regionId_code: { regionId: region.id, code: input.territoryCode },
        },
      });
      if (!territory) {
        throw new NotFoundException(
          `Unknown territory ${input.territoryCode} in ${input.regionCode}`,
        );
      }
      territoryId = territory.id;
    }

    const existing = await this.prisma.adminUser.findUnique({
      where: { email: input.email },
    });
    if (existing) {
      throw new ConflictException('Admin with this email already exists');
    }

    const admin = await this.prisma.adminUser.create({
      data: {
        email: input.email,
        name: input.name ?? null,
        role: input.role,
        active: true,
        scopes: {
          create: {
            scopeType:
              input.role === AdminRole.STATE_MASTER
                ? AdminScopeType.STATE
                : AdminScopeType.LOCAL,
            regionId: region.id,
            localTerritoryId: territoryId,
          },
        },
      },
      include: {
        scopes: {
          include: { region: true, localTerritory: true },
        },
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.ADMIN_PROVISIONED,
      actorAdminId: actor.id,
      entityType: 'AdminUser',
      entityId: admin.id,
      metadata: {
        email: admin.email,
        role: admin.role,
        regionCode: input.regionCode,
        territoryCode: input.territoryCode ?? null,
      },
    });

    void this.notifications.sendMail({
      to: admin.email,
      subject: 'CLOX admin access provisioned',
      text: `You have been provisioned as ${admin.role} on CLOX. Sign in with OTP using this email.`,
      html: `<p>You have been provisioned as <strong>${admin.role}</strong> on CLOX.</p><p>Sign in with OTP using this email.</p>`,
    });

    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      scopes: admin.scopes.map((s) => ({
        scopeType: s.scopeType,
        regionCode: s.region?.code ?? null,
        territoryCode: s.localTerritory?.code ?? null,
      })),
    };
  }

  /** Demo policy mutation — Super only + step-up (M1). */
  async publishPolicyStub(actor: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const version = await this.prisma.policyVersion.create({
      data: {
        key: 'pilot.enabled_states',
        version: Date.now(),
        payload: { enabled_states: ['VIC'] },
        publishedAt: new Date(),
        publishedBy: actor.id,
      },
    });
    return { id: version.id, key: version.key, version: version.version };
  }
}
