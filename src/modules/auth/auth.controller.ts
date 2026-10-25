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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @ApiBody({
    description: 'Provide email and/or phone (at least one required).',
    schema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          format: 'email',
          example: 'sender@example.com',
        },
        phone: {
          type: 'string',
          example: '+61412345678',
          description: 'Optional; email or phone required',
        },
        deviceLabel: {
          type: 'string',
          example: 'Swagger',
          maxLength: 120,
        },
      },
    },
    examples: {
      email: {
        summary: 'Email login',
        value: { email: 'sender@example.com', deviceLabel: 'Swagger' },
      },
    },
  })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  requestOtp(@Body(new ZodValidationPipe(otpRequestSchema)) body: OtpRequestInput) {
    return this.authService.requestOtp(body);
  }

  @Post('otp/verify')
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Verify OTP and receive JWT + session' })
  @ApiBody({
    description: 'Same email/phone used for request, plus the OTP code.',
    schema: {
      type: 'object',
      required: ['code'],
      properties: {
        email: { type: 'string', format: 'email', example: 'sender@example.com' },
        phone: { type: 'string', example: '+61412345678' },
        code: { type: 'string', example: '123456', pattern: '^\\d{4,8}$' },
        deviceLabel: { type: 'string', example: 'Swagger', maxLength: 120 },
      },
    },
    examples: {
      email: {
        summary: 'Verify with email',
        value: { email: 'sender@example.com', code: '123456' },
      },
    },
  })
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
  @ApiBody({
    schema: {
      type: 'object',
      required: ['refreshToken'],
      properties: {
        refreshToken: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
      },
    },
  })
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
  @ApiBody({
    schema: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string', example: '123456', pattern: '^\\d{4,8}$' },
      },
    },
  })
  verifyStepUp(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(stepUpVerifySchema)) body: StepUpVerifyInput,
  ) {
    return this.authService.verifyStepUp(principal, body);
  }
}
