import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { RevenueSplitController } from './revenue-split.controller';
import { RevenueSplitService } from './revenue-split.service';
import { SettlementsController } from './settlements.controller';

@Module({
  imports: [JwtModule.register({}), AuditModule],
  controllers: [SettlementsController, RevenueSplitController],
  providers: [RevenueSplitService, JwtAuthGuard, RolesGuard],
  exports: [RevenueSplitService],
})
export class SettlementsModule {}
