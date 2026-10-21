import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  AdminUserStatus,
  CompanyType,
  type Prisma,
} from '@prisma/client';
import { hashValue } from '../utils/crypto';
import type { AuthenticatedPrincipal } from '../guards/jwt-auth.guard';
import { AdminRole } from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';

export type ResolvedCompanyInvite = {
  referredByAdminUserId: string | null;
  inviteId: string | null;
  prospectId: string | null;
  homeRegionId: string | null;
};

/**
 * Book-of-business attribution for Local BDE.
 * Isolation key = Company.referredByAdminUserId (not territory alone).
 */
@Injectable()
export class AttributionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve optional invite token at register time.
   * Invalid / expired / wrong type / already accepted → HQ (null referrer). Never invent an owner.
   */
  async resolveInviteForRegister(
    token: string | undefined,
    expectedType: CompanyType,
  ): Promise<ResolvedCompanyInvite> {
    const empty: ResolvedCompanyInvite = {
      referredByAdminUserId: null,
      inviteId: null,
      prospectId: null,
      homeRegionId: null,
    };
    if (!token?.trim()) {
      return empty;
    }

    const invite = await this.prisma.companyInvite.findUnique({
      where: { tokenHash: hashValue(token.trim()) },
      include: {
        invitedByAdminUser: { select: { id: true, role: true, status: true } },
      },
    });
    if (!invite) return empty;
    if (invite.acceptedAt) return empty;
    if (invite.expiresAt < new Date()) return empty;
    if (invite.companyType !== expectedType) return empty;
    if (
      invite.invitedByAdminUser.role !== AdminRole.LOCAL_BDE ||
      invite.invitedByAdminUser.status !== AdminUserStatus.ACTIVE
    ) {
      return empty;
    }

    return {
      referredByAdminUserId: invite.invitedByAdminUserId,
      inviteId: invite.id,
      prospectId: invite.prospectId,
      homeRegionId: invite.homeRegionId,
    };
  }

  async markInviteAccepted(inviteId: string, companyId: string) {
    await this.prisma.companyInvite.update({
      where: { id: inviteId },
      data: {
        acceptedAt: new Date(),
        companyId,
      },
    });
    const invite = await this.prisma.companyInvite.findUnique({
      where: { id: inviteId },
      select: { prospectId: true },
    });
    if (invite?.prospectId) {
      await this.prisma.prospect.update({
        where: { id: invite.prospectId },
        data: {
          companyId,
          stage: 'ONBOARDING',
        },
      });
    }
  }

  /** Local BDE may only access companies they referred. */
  assertLocalOwnsCompany(
    principal: AuthenticatedPrincipal,
    company: { referredByAdminUserId: string | null },
  ) {
    if (principal.role !== AdminRole.LOCAL_BDE) return;
    if (company.referredByAdminUserId !== principal.id) {
      throw new ForbiddenException('Outside your book of business');
    }
  }

  assertLocalOwnsProspect(
    principal: AuthenticatedPrincipal,
    prospect: { ownerAdminUserId: string },
  ) {
    if (principal.role !== AdminRole.LOCAL_BDE) return;
    if (prospect.ownerAdminUserId !== principal.id) {
      throw new ForbiddenException('Outside your book of business');
    }
  }

  /**
   * Extra Company where-clause for list/detail isolation.
   * Super: none. State: homeRegion in scope. Local: referredBy = self.
   */
  companyBookFilter(principal: AuthenticatedPrincipal): Prisma.CompanyWhereInput {
    if (principal.role === AdminRole.SUPER_ADMIN) {
      return {};
    }
    if (principal.role === AdminRole.STATE_MASTER) {
      const regions = principal.regionCodes;
      if (regions.length < 1) {
        return { id: '__none__' };
      }
      return { homeRegion: { code: { in: regions } } };
    }
    if (principal.role === AdminRole.LOCAL_BDE) {
      return { referredByAdminUserId: principal.id };
    }
    return { id: '__none__' };
  }

  /** ComplianceCase where for Local = only referred companies. */
  complianceCaseBookFilter(
    principal: AuthenticatedPrincipal,
  ): Prisma.ComplianceCaseWhereInput | null {
    if (principal.role !== AdminRole.LOCAL_BDE) {
      return null;
    }
    return { company: { referredByAdminUserId: principal.id } };
  }
}
