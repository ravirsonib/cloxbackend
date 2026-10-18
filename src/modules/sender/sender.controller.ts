import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  AppRole,
  senderPaymentConfirmSchema,
  senderProfileSchema,
  senderRegisterSchema,
  senderSubmitVerificationSchema,
  type SenderPaymentConfirmInput,
  type SenderProfileInput,
  type SenderRegisterInput,
  type SenderSubmitVerificationInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SenderService } from './sender.service';

@ApiTags('sender')
@Controller('sender')
export class SenderController {
  constructor(private readonly senderService: SenderService) {}

  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register new sender (then OTP login)' })
  register(@Body(new ZodValidationPipe(senderRegisterSchema)) body: SenderRegisterInput) {
    return this.senderService.register(body);
  }

  @Get('onboarding')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Sender onboarding status + go/no-go' })
  onboarding(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.senderService.getOnboarding(principal);
  }

  @Put('profile')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Save account type + invoice profile' })
  profile(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(senderProfileSchema)) body: SenderProfileInput,
  ) {
    return this.senderService.updateProfile(principal, body);
  }

  @Post('verification/submit')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Submit docs for Ops manual KYB/KYC' })
  submit(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(senderSubmitVerificationSchema))
    body: SenderSubmitVerificationInput,
  ) {
    return this.senderService.submitVerification(principal, body);
  }

  @Post('payment/setup')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Create Stripe Customer + SetupIntent (or mock)' })
  paymentSetup(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.senderService.createPaymentSetup(principal);
  }

  @Post('payment/confirm')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Confirm default PM → sender_active' })
  paymentConfirm(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(senderPaymentConfirmSchema)) body: SenderPaymentConfirmInput,
  ) {
    return this.senderService.confirmPayment(principal, body);
  }

  @Get('booking-eligibility')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Go/no-go: can create jobs?' })
  bookingEligibility(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.senderService.getBookingEligibility(principal);
  }
}
