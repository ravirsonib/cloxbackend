import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { FinanceService } from './finance.service';
import { RevenueSplitController } from './revenue-split.controller';
import { RevenueSplitService } from './revenue-split.service';
import { SettlementsController } from './settlements.controller';

@Module({
  imports: [JwtModule.register({}), AuditModule],
  controllers: [SettlementsController, RevenueSplitController],
  providers: [FinanceService, RevenueSplitService, JwtAuthGuard, RolesGuard],
  exports: [FinanceService, RevenueSplitService],
})
export class SettlementsModule {}
