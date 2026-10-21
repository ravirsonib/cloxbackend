import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminRole,
  createCompanyInviteSchema,
  createProspectSchema,
  growthMyCompaniesQuerySchema,
  prospectListQuerySchema,
  reassignCompanyReferrerSchema,
  updateProspectSchema,
  type CreateCompanyInviteInput,
  type CreateProspectInput,
  type GrowthMyCompaniesQuery,
  type ProspectListQuery,
  type ReassignCompanyReferrerInput,
  type UpdateProspectInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { GrowthService } from './growth.service';

@ApiTags('growth')
@Controller('ops/growth')
export class GrowthController {
  constructor(private readonly growth: GrowthService) {}

  @Post('invites')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Local BDE: invite sender or carrier into book of business' })
  createInvite(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(createCompanyInviteSchema)) body: CreateCompanyInviteInput,
  ) {
    return this.growth.createInvite(principal, body);
  }

  @Post('invites/:id/resend')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Local BDE: resend company invite' })
  resendInvite(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.growth.resendInvite(principal, id);
  }

  @Get('invites')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Local BDE: list own company invites' })
  listInvites(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.growth.listInvites(principal);
  }

  @Get('my-companies')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Local BDE: companies referred by self' })
  listMyCompanies(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(growthMyCompaniesQuerySchema)) query: GrowthMyCompaniesQuery,
  ) {
    return this.growth.listMyCompanies(principal, query);
  }

  @Get('prospects')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'List prospects (Local = own; Super/State = read in scope)' })
  listProspects(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(prospectListQuerySchema)) query: ProspectListQuery,
  ) {
    return this.growth.listProspects(principal, query);
  }

  @Post('prospects')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Local BDE: create prospect' })
  createProspect(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(createProspectSchema)) body: CreateProspectInput,
  ) {
    return this.growth.createProspect(principal, body);
  }

  @Get('prospects/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Get prospect detail' })
  getProspect(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.growth.getProspect(principal, id);
  }

  @Patch('prospects/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.LOCAL_BDE)
  @ApiOperation({ summary: 'Local BDE: update own prospect' })
  updateProspect(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProspectSchema)) body: UpdateProspectInput,
  ) {
    return this.growth.updateProspect(principal, id, body);
  }

  @Get('companies/:id/referrer')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER)
  @ApiOperation({ summary: 'Super/State: company book owner' })
  getCompanyReferrer(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.growth.getCompanyReferrer(principal, id);
  }

  @Post('companies/:id/reassign-referrer')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER)
  @ApiOperation({ summary: 'Super/State: reassign company to another Local (or HQ)' })
  reassignReferrer(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reassignCompanyReferrerSchema))
    body: ReassignCompanyReferrerInput,
  ) {
    return this.growth.reassignReferrer(principal, id, body);
  }

  @Get('local-bdes')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER)
  @ApiOperation({ summary: 'Active Local BDEs for reassignment picker' })
  listLocalBdes(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.growth.listLocalBdesForReassign(principal);
  }
}

@ApiTags('public-growth')
@Controller('public')
export class GrowthPublicController {
  constructor(private readonly growth: GrowthService) {}

  @Get('company-invite/:token')
  @ApiOperation({ summary: 'Public preview of Local BDE company invite' })
  peek(@Param('token') token: string) {
    return this.growth.peekInvite(token);
  }
}
