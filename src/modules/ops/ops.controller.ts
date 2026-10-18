import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole, provisionAdminSchema, type ProvisionAdminInput } from '../../shared/types';
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

  @Post('admins')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Provision State Master or Local BDE (Super only)' })
  provisionAdmin(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(provisionAdminSchema)) body: ProvisionAdminInput,
  ) {
    return this.opsService.provisionAdmin(principal, body);
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
