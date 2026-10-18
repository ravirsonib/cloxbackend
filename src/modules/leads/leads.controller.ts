import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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

  @Post('registry')
  @ApiOperation({ summary: 'Submit sender/carrier registry lead' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createRegistry(
    @Body(new ZodValidationPipe(registryLeadSchema)) body: RegistryLeadInput,
    @Req() req: Request,
  ) {
    return this.leadsService.createRegistryLead(body, {
      ip: req.ip || req.socket.remoteAddress,
    });
  }

  @Post('eoi')
  @ApiOperation({ summary: 'Submit Admin Partner EOI lead' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createEoi(
    @Body(new ZodValidationPipe(eoiLeadSchema)) body: EoiLeadInput,
    @Req() req: Request,
  ) {
    return this.leadsService.createEoiLead(body, {
      ip: req.ip || req.socket.remoteAddress,
    });
  }

  @Post('investor')
  @ApiOperation({ summary: 'Submit investor pre-qualification lead' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createInvestor(
    @Body(new ZodValidationPipe(investorLeadSchema)) body: InvestorLeadInput,
    @Req() req: Request,
  ) {
    return this.leadsService.createInvestorLead(body, {
      ip: req.ip || req.socket.remoteAddress,
    });
  }
}
