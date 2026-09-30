import { Body, Controller, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  eoiLeadSchema,
  investorLeadSchema,
  registryLeadSchema,
  type EoiLeadInput,
  type InvestorLeadInput,
  type RegistryLeadInput,
} from '../../shared/types';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { LeadsService } from './leads.service';

@ApiTags('leads')
@Controller('leads')
@UseGuards(ThrottlerGuard)
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  private resolveIdempotencyKey(
    headerValue: string | undefined,
    bodyKey?: string,
  ): string | undefined {
    const fromHeader = headerValue?.trim();
    if (fromHeader && fromHeader.length >= 8 && fromHeader.length <= 128) {
      return fromHeader;
    }
    const fromBody = bodyKey?.trim();
    if (fromBody && fromBody.length >= 8 && fromBody.length <= 128) {
      return fromBody;
    }
    return undefined;
  }

  @Post('registry')
  @ApiOperation({ summary: 'Submit sender/carrier registry lead' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Client-generated key (8–128 chars). Reuse on timeout retries to avoid duplicate leads.',
  })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createRegistry(
    @Body(new ZodValidationPipe(registryLeadSchema)) body: RegistryLeadInput,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Req() req: Request,
  ) {
    return this.leadsService.createRegistryLead(body, {
      ip: req.ip || req.socket.remoteAddress,
      idempotencyKey: this.resolveIdempotencyKey(
        idempotencyKeyHeader,
        body.idempotencyKey,
      ),
    });
  }

  @Post('eoi')
  @ApiOperation({ summary: 'Submit Admin Partner EOI lead' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Client-generated key (8–128 chars). Reuse on timeout retries to avoid duplicate leads.',
  })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createEoi(
    @Body(new ZodValidationPipe(eoiLeadSchema)) body: EoiLeadInput,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Req() req: Request,
  ) {
    return this.leadsService.createEoiLead(body, {
      ip: req.ip || req.socket.remoteAddress,
      idempotencyKey: this.resolveIdempotencyKey(
        idempotencyKeyHeader,
        body.idempotencyKey,
      ),
    });
  }

  @Post('investor')
  @ApiOperation({ summary: 'Submit investor pre-qualification lead' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Client-generated key (8–128 chars). Reuse on timeout retries to avoid duplicate leads.',
  })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createInvestor(
    @Body(new ZodValidationPipe(investorLeadSchema)) body: InvestorLeadInput,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Req() req: Request,
  ) {
    return this.leadsService.createInvestorLead(body, {
      ip: req.ip || req.socket.remoteAddress,
      idempotencyKey: this.resolveIdempotencyKey(
        idempotencyKeyHeader,
        body.idempotencyKey,
      ),
    });
  }
}
