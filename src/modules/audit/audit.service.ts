import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Phase 0 lead timeline (LeadEvent). */
  async record(params: {
    action: string;
    leadId?: string;
    actorId?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    if (!this.prisma.isConnected()) {
      return null;
    }
    return this.prisma.leadEvent.create({
      data: {
        action: params.action,
        leadId: params.leadId,
        actorId: params.actorId,
        metadata: params.metadata,
      },
    });
  }

  /** Phase 1 platform audit (AuditEvent). */
  async recordPlatform(params: {
    action: string;
    actorAdminId?: string;
    actorUserId?: string;
    entityType?: string;
    entityId?: string;
    correlationId?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    if (!this.prisma.isConnected()) {
      return null;
    }
    return this.prisma.auditEvent.create({
      data: {
        action: params.action,
        actorAdminId: params.actorAdminId,
        actorUserId: params.actorUserId,
        entityType: params.entityType,
        entityId: params.entityId,
        correlationId: params.correlationId,
        metadata: params.metadata,
      },
    });
  }
}
