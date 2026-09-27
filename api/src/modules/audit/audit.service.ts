import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(params: {
    action: string;
    leadId?: string;
    actorId?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.prisma.leadEvent.create({
      data: {
        action: params.action,
        leadId: params.leadId,
        actorId: params.actorId,
        metadata: params.metadata,
      },
    });
  }
}
