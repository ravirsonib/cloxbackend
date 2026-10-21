import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminRole,
  adminAcceptInviteSchema,
  inviteAdminSchema,
  partnerOnboardingSubmitSchema,
  partnerOnboardingUpdateSchema,
  resendAdminInviteSchema,
  type AdminAcceptInviteInput,
  type InviteAdminInput,
  type PartnerOnboardingSubmitInput,
  type PartnerOnboardingUpdateInput,
  type ResendAdminInviteInput,
} from '../../shared/types';
import { AllowPendingPartner } from '../../common/decorators/allow-pending-partner.decorator';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { OpsService } from './ops.service';

@ApiTags('ops')
@Controller('ops')
export class OpsController {
  constructor(private readonly opsService: OpsService) {}

  @Get('_status')
  @ApiOperation({ summary: 'Ops module status' })
  status() {
    return { module: 'ops', status: 'ready', milestone: 'M1' };
  }

  @Post('admins/invite')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Invite State Master or Local BDE (Super only) — KYB required before ACTIVE',
  })
  inviteAdmin(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(inviteAdminSchema)) body: InviteAdminInput,
  ) {
    return this.opsService.inviteAdmin(principal, body);
  }

  @Post('admins/invite/resend')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Resend admin partner invite' })
  resendInvite(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(resendAdminInviteSchema)) body: ResendAdminInviteInput,
  ) {
    return this.opsService.resendAdminInvite(principal, body);
  }

  @Get('admins/partners')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List State Master / Local BDE partner admins' })
  listPartners(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.opsService.listPartnerAdmins(principal);
  }

  @Get('geography')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List AU regions and local territories (invite pickers)' })
  listGeography(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.opsService.listGeography(principal);
  }

  /** @deprecated Prefer POST /ops/admins/invite — same invite-only behaviour. */
  @Post('admins')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Deprecated: use POST /ops/admins/invite (no longer activates immediately)',
  })
  provisionAdmin(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(inviteAdminSchema)) body: InviteAdminInput,
  ) {
    return this.opsService.inviteAdmin(principal, body);
  }

  @Get('admins/invite/:token')
  @ApiOperation({ summary: 'Peek admin partner invite (public)' })
  peekInvite(@Param('token') token: string) {
    return this.opsService.peekAdminInvite(token);
  }

  @Post('admins/invite/accept')
  @ApiOperation({ summary: 'Accept admin partner invite (public)' })
  acceptInvite(
    @Body(new ZodValidationPipe(adminAcceptInviteSchema)) body: AdminAcceptInviteInput,
  ) {
    return this.opsService.acceptAdminInvite(body);
  }

  @Get('partner/onboarding')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE)
  @AllowPendingPartner()
  @ApiOperation({ summary: 'Partner self onboarding status' })
  getOnboarding(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.opsService.getPartnerOnboarding(principal);
  }

  @Patch('partner/onboarding')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE)
  @AllowPendingPartner()
  @ApiOperation({ summary: 'Update partner onboarding profile' })
  patchOnboarding(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(partnerOnboardingUpdateSchema))
    body: PartnerOnboardingUpdateInput,
  ) {
    return this.opsService.updatePartnerOnboarding(principal, body);
  }

  @Post('partner/onboarding/submit')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE)
  @AllowPendingPartner()
  @ApiOperation({ summary: 'Submit partner KYB for Super review' })
  submitOnboarding(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(partnerOnboardingSubmitSchema))
    body: PartnerOnboardingSubmitInput,
  ) {
    return this.opsService.submitPartnerOnboarding(principal, body);
  }

  @Post('policy/publish-stub')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, StepUpGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Sensitive policy publish stub — requires X-Step-Up-Token',
  })
  publishPolicy(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.opsService.publishPolicyStub(principal);
  }
}
