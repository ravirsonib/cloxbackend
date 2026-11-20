import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
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
import {
  RunDisbursementInput,
  SettlementCyclesService,
} from './settlement-cycles.service';
import { ReconciliationService } from './reconciliation.service';

@ApiTags('settlements')
@Controller('settlements')
export class SettlementsController {
  constructor(
    private readonly financeService?: FinanceService,
    private readonly cyclesService?: SettlementCyclesService,
    private readonly reconcileService?: ReconciliationService,
  ) {}

  @Get('_status')
  @ApiOperation({ summary: 'Settlements module status' })
  status() {
    return {
      module: 'settlements',
      status: 'production',
      milestone: 'M12',
      implemented: true,
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

  @Get('finance/super/export')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary: 'Export Super Admin period-filtered finance ledger as CSV (AUD cents)',
  })
  async exportSuperFinance(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(financeQuerySchema)) query: FinanceQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.financeService) throw new Error('FinanceService unavailable');
    const { csv, filename } = await this.financeService.exportSuperFinanceCsv(
      principal,
      query,
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  }

  @Get('finance/partner/export')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary: 'Export partner commission ledger CSV for the selected period',
  })
  async exportPartnerFinance(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(financeQuerySchema)) query: FinanceQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.financeService) throw new Error('FinanceService unavailable');
    const { csv, filename } = await this.financeService.exportPartnerFinanceCsv(
      principal,
      query,
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  }

  @Get('finance/carrier/export')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY, AdminRole.SUPER_ADMIN)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary: 'Export carrier settlement / transfer ledger CSV for the selected period',
  })
  async exportCarrierFinance(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(financeQuerySchema)) query: FinanceQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.financeService) throw new Error('FinanceService unavailable');
    const { csv, filename } = await this.financeService.exportCarrierFinanceCsv(
      principal,
      query,
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  }

  @Get('finance/sender/export')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER, AdminRole.SUPER_ADMIN)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary: 'Export sender charge / surcharge ledger CSV for the selected period',
  })
  async exportSenderFinance(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(financeQuerySchema)) query: FinanceQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.financeService) throw new Error('FinanceService unavailable');
    const { csv, filename } = await this.financeService.exportSenderFinanceCsv(
      principal,
      query,
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  }

  // ─── M12: Settlement Cycles & Disbursement ───────────────────────────────────

  @Get('cycles')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER)
  @ApiOperation({ summary: 'List fortnightly settlement cycles' })
  listCycles(
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    if (!this.cyclesService) throw new Error('SettlementCyclesService unavailable');
    return this.cyclesService.listCycles({
      page: pageRaw ? Number(pageRaw) : undefined,
      limit: limitRaw ? Number(limitRaw) : undefined,
    });
  }

  @Get('cycles/active')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get or create current open settlement cycle' })
  getActiveCycle() {
    if (!this.cyclesService) throw new Error('SettlementCyclesService unavailable');
    return this.cyclesService.getOrCreateActiveCycle();
  }

  @Get('cycles/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER)
  @ApiOperation({ summary: 'Get settlement cycle breakdown and line items' })
  getCycleDetail(@Param('id', ParseUUIDPipe) id: string) {
    if (!this.cyclesService) throw new Error('SettlementCyclesService unavailable');
    return this.cyclesService.getCycleDetail(id);
  }

  @Post('cycles/run')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Execute fortnightly settlement disbursement run (Super Admin only, supports dryRun)',
  })
  runDisbursement(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() input?: RunDisbursementInput,
  ) {
    if (!this.cyclesService) throw new Error('SettlementCyclesService unavailable');
    return this.cyclesService.runDisbursement(principal, input);
  }

  // ─── M12: Daily Reconciliation & Anomaly Detection ──────────────────────────

  @Get('reconcile')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Daily Stripe vs internal ledger reconciliation report with discrepancy detection',
  })
  getReconciliation(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!this.reconcileService) throw new Error('ReconciliationService unavailable');
    return this.reconcileService.getReconciliationReport(principal, { from, to });
  }
}
