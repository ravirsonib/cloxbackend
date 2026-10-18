import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  logoutSchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshTokenSchema,
  stepUpVerifySchema,
  type LogoutInput,
  type OtpRequestInput,
  type OtpVerifyInput,
  type RefreshTokenInput,
  type StepUpVerifyInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { hashValue } from '../../common/utils/crypto';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('otp/request')
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Request OTP (any of 6 roles — email or phone)' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  requestOtp(@Body(new ZodValidationPipe(otpRequestSchema)) body: OtpRequestInput) {
    return this.authService.requestOtp(body);
  }

  @Post('otp/verify')
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Verify OTP and receive JWT + session' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifyOtp(
    @Body(new ZodValidationPipe(otpVerifySchema)) body: OtpVerifyInput,
    @Headers('user-agent') userAgent?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const ip = forwardedFor?.split(',')[0]?.trim();
    return this.authService.verifyOtp(body, {
      userAgent,
      ipHash: ip ? hashValue(ip) : undefined,
    });
  }

  @Post('refresh')
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Rotate refresh token' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  refresh(@Body(new ZodValidationPipe(refreshTokenSchema)) body: RefreshTokenInput) {
    return this.authService.refresh(body);
  }

  @Post('logout')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Revoke current (or all) sessions' })
  logout(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(logoutSchema)) body: LogoutInput,
  ) {
    return this.authService.logout(principal, body);
  }

  @Get('sessions')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List active sessions (SHR-PROF-01)' })
  listSessions(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.authService.listSessions(principal);
  }

  @Delete('sessions/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Revoke a session by id' })
  revokeSession(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.authService.revokeSession(principal, id);
  }

  @Post('otp/step-up/request')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request step-up OTP for sensitive admin actions' })
  requestStepUp(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.authService.requestStepUp(principal);
  }

  @Post('otp/step-up/verify')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify step-up OTP → short-lived X-Step-Up-Token' })
  verifyStepUp(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(stepUpVerifySchema)) body: StepUpVerifyInput,
  ) {
    return this.authService.verifyStepUp(principal, body);
  }
}
