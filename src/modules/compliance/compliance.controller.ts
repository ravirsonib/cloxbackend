import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminRole,
  abrLookupQuerySchema,
  complianceCaseListQuerySchema,
  complianceDecisionSchema,
  submitComplianceSchema,
  type AbrLookupQuery,
  type ComplianceCaseListQuery,
  type ComplianceDecisionInput,
  type SubmitComplianceInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AbrService } from './abr.service';
import { ComplianceService } from './compliance.service';

@ApiTags('compliance')
@Controller()
export class ComplianceController {
  constructor(
    private readonly complianceService: ComplianceService,
    private readonly abrService: AbrService,
  ) {}

  @Get('compliance/_status')
  @ApiOperation({ summary: 'Compliance module status' })
  status() {
    return { module: 'compliance', status: 'ready', milestone: 'M2' };
  }

  @Post('compliance/submit')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Submit company docs for Ops manual review' })
  submit(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(submitComplianceSchema)) body: SubmitComplianceInput,
  ) {
    return this.complianceService.submit(principal, body);
  }

  @Get('compliance/abr')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Optional ABR ABN lookup (assist Ops only — not auto-approve)' })
  abrLookup(@Query(new ZodValidationPipe(abrLookupQuerySchema)) query: AbrLookupQuery) {
    return this.abrService.lookupAbn(query.abn);
  }

  @Get('ops/compliance/cases')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Ops compliance queue (scoped by AdminScope)' })
  listCases(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(complianceCaseListQuerySchema))
    query: ComplianceCaseListQuery,
  ) {
    return this.complianceService.listCases(principal, query);
  }

  @Get('ops/compliance/cases/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Compliance case detail + ABR assist' })
  getCase(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.complianceService.getCase(principal, id);
  }

  @Post('ops/compliance/cases/:id/approve')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER)
  @ApiOperation({ summary: 'Approve case (Super / State) — Local denied' })
  approve(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(complianceDecisionSchema)) body: ComplianceDecisionInput,
  ) {
    return this.complianceService.approve(principal, id, body);
  }

  @Post('ops/compliance/cases/:id/reject')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER)
  @ApiOperation({ summary: 'Reject case (Super / State)' })
  reject(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(complianceDecisionSchema)) body: ComplianceDecisionInput,
  ) {
    return this.complianceService.reject(principal, id, body);
  }

  @Post('ops/compliance/cases/:id/request-info')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER)
  @ApiOperation({ summary: 'Request more information from applicant' })
  requestInfo(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(complianceDecisionSchema)) body: ComplianceDecisionInput,
  ) {
    return this.complianceService.requestInfo(principal, id, body);
  }

  @Post('ops/compliance/cases/:id/escalate')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Local BDE escalate only (G0-4)' })
  escalate(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(complianceDecisionSchema)) body: ComplianceDecisionInput,
  ) {
    return this.complianceService.escalate(principal, id, body);
  }
}
