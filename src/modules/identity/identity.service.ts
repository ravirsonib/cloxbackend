import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  async getMe(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();

    if (principal.kind === 'admin') {
      const admin = await this.prisma.adminUser.findUniqueOrThrow({
        where: { id: principal.id },
        include: {
          scopes: {
            include: { region: true, localTerritory: true },
          },
        },
      });
      return {
        kind: 'admin' as const,
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        active: admin.active,
        scopes: admin.scopes.map((s) => ({
          scopeType: s.scopeType,
          regionCode: s.region?.code ?? null,
          territoryCode: s.localTerritory?.code ?? null,
        })),
      };
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.id },
      include: { company: true },
    });

    return {
      kind: 'user' as const,
      id: user.id,
      email: user.email,
      phone: user.phone,
      name: user.name,
      role: user.role,
      status: user.status,
      company: user.company
        ? {
            id: user.company.id,
            type: user.company.type,
            legalName: user.company.legalName,
            status: user.company.status,
          }
        : null,
    };
  }
}
