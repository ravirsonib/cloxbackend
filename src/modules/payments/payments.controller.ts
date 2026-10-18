import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { AppRole } from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly stripe: StripeService,
  ) {}

  @Get('_status')
  @ApiOperation({ summary: 'Payments module status (M7/M9)' })
  status() {
    return {
      module: 'payments',
      status: 'ready',
      milestone: 'M9',
      stripeMock: this.stripe.isMockMode(),
    };
  }

  @Get('surcharges')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER, AppRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Sender surcharge inbox / Super ops waive queue (SND-SRG)' })
  listSurcharges(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.payments.listSenderSurcharges(principal);
  }

  @Post('surcharges/:id/pay')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Pay pending surcharge (mass / waiting)' })
  paySurcharge(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.payments.paySurcharge(principal, id);
  }

  @Post('surcharges/:id/waive')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Ops waive surcharge (Super only)' })
  waiveSurcharge(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.payments.waiveSurcharge(principal, id);
  }

  @Get('exceptions')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Carrier read-only surcharge exceptions (TCO-ASN-02)' })
  exceptions(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.payments.listCarrierExceptions(principal);
  }

  @Post('stripe/webhook')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Stripe webhook (signature verified; mock accepts JSON)' })
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
    @Body() _body: unknown,
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(_body ?? {}));
    return this.payments.handleStripeWebhook(raw, signature);
  }

  @Get('jobs/:jobId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER, AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Job payment + assignment lock status' })
  jobPayment(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('jobId') jobId: string,
  ) {
    return this.payments.getJobPaymentStatus(principal, jobId);
  }

  @Get('assignments')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Carrier assignments (TCO-ASN)' })
  assignments(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.payments.listCarrierAssignments(principal);
  }

  @Post('jobs/:jobId/refund-stub')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER, AppRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Refund stub (full cancel path M10/M12)' })
  refundStub(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('jobId') jobId: string,
  ) {
    return this.payments.refundStub(principal, jobId);
  }
}
