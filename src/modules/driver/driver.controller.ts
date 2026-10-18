import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  AppRole,
  driverAcceptInviteSchema,
  driverProfileSchema,
  type DriverAcceptInviteInput,
  type DriverProfileInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DriverService } from './driver.service';

@ApiTags('driver')
@Controller('driver')
export class DriverController {
  constructor(private readonly driverService: DriverService) {}

  @Get('invite/:token')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Peek driver invite (public)' })
  peek(@Param('token') token: string) {
    return this.driverService.peekInvite(token);
  }

  @Post('invite/accept')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Accept invite (single-use token) → then OTP login' })
  accept(@Body(new ZodValidationPipe(driverAcceptInviteSchema)) body: DriverAcceptInviteInput) {
    return this.driverService.acceptInvite(body);
  }

  @Get('onboarding')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Driver onboarding status' })
  onboarding(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.driverService.getOnboarding(principal);
  }

  @Put('profile')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Submit licence + NHVR ack → auto-activate (Phase 1)' })
  profile(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(driverProfileSchema)) body: DriverProfileInput,
  ) {
    return this.driverService.submitProfile(principal, body);
  }

  @Get('assignability')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Whether driver can be assigned (orphan / licence gate)' })
  assignability(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.driverService.getAssignability(principal);
  }
}
