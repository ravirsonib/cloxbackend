import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { FinanceService } from './finance.service';
import { RevenueSplitController } from './revenue-split.controller';
import { RevenueSplitService } from './revenue-split.service';
import { SettlementCyclesService } from './settlement-cycles.service';
import { SettlementCycleWatchdog } from './settlement-cycle.watchdog';
import { ReconciliationService } from './reconciliation.service';
import { SettlementsController } from './settlements.controller';

@Module({
  imports: [
    JwtModule.register({}),
    AuditModule,
    NotificationsModule,
    forwardRef(() => PaymentsModule),
  ],
  controllers: [SettlementsController, RevenueSplitController],
  providers: [
    FinanceService,
    RevenueSplitService,
    SettlementCyclesService,
    SettlementCycleWatchdog,
    ReconciliationService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [
    FinanceService,
    RevenueSplitService,
    SettlementCyclesService,
    ReconciliationService,
  ],
})
export class SettlementsModule {}
