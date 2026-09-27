import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  otpRequestSchema,
  otpVerifySchema,
  refreshTokenSchema,
  type OtpRequestInput,
  type OtpVerifyInput,
  type RefreshTokenInput,
} from '../../shared/types';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('otp/request')
  @ApiOperation({ summary: 'Request Super Admin OTP email' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  requestOtp(@Body(new ZodValidationPipe(otpRequestSchema)) body: OtpRequestInput) {
    return this.authService.requestOtp(body);
  }

  @Post('otp/verify')
  @ApiOperation({ summary: 'Verify OTP and receive JWT tokens' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifyOtp(@Body(new ZodValidationPipe(otpVerifySchema)) body: OtpVerifyInput) {
    return this.authService.verifyOtp(body);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  refresh(@Body(new ZodValidationPipe(refreshTokenSchema)) body: RefreshTokenInput) {
    return this.authService.refresh(body);
  }
}
