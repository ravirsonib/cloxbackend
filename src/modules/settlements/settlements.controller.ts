import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminRole,
  AppRole,
  financeQuerySchema,
  type FinanceQuery,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  type AuthenticatedPrincipal,
} from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { FinanceService } from './finance.service';

@ApiTags('settlements')
@Controller('settlements')
export class SettlementsController {
  constructor(private readonly financeService?: FinanceService) {}

  @Get('_status')
  @ApiOperation({ summary: 'Settlements module status' })
  status() {
    return {
      module: 'settlements',
      status: 'scaffold',
      milestone: 'M10',
      implemented: false,
    };
  }

  @Get('finance/super')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Super Admin global financial overview: GMV, Platform profit, Carrier payouts, Partner commissions, Surcharges & Regional breakdown',
  })
  getSuperFinance(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(financeQuerySchema)) query: FinanceQuery,
  ) {
    if (!this.financeService) throw new Error('FinanceService unavailable');
    return this.financeService.getSuperFinanceOverview(principal, query);
  }

  @Get('finance/partner')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE)
  @ApiOperation({
    summary:
      'Partner Admin (State Master / Local BDE) scoped revenue and commission overview',
  })
  getPartnerFinance(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(financeQuerySchema)) query: FinanceQuery,
  ) {
    if (!this.financeService) throw new Error('FinanceService unavailable');
    return this.financeService.getPartnerFinance(principal, query);
  }

  @Get('finance/carrier')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY, AdminRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Carrier earnings, 7-day clearing pipeline, and Stripe payout history',
  })
  getCarrierFinance(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(financeQuerySchema)) query: FinanceQuery,
  ) {
    if (!this.financeService) throw new Error('FinanceService unavailable');
    return this.financeService.getCarrierFinance(principal, query);
  }

  @Get('finance/sender')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER, AdminRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Sender freight spending, surcharges incurred, and job-by-job spend history',
  })
  getSenderFinance(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(financeQuerySchema)) query: FinanceQuery,
  ) {
    if (!this.financeService) throw new Error('FinanceService unavailable');
    return this.financeService.getSenderFinance(principal, query);
  }
}
