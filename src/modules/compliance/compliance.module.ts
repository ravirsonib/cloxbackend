import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ScopeService } from '../../common/services/scope.service';
import { AuditModule } from '../audit/audit.module';
import { AbrService } from './abr.service';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ExpiryWatchdogService } from './expiry-watchdog.service';
import { DriverModule } from '../driver/driver.module';

@Module({
  imports: [JwtModule.register({}), AuditModule, DriverModule],
  controllers: [ComplianceController],
  providers: [
    ComplianceService,
    AbrService,
    ExpiryWatchdogService,
    JwtAuthGuard,
    RolesGuard,
    ScopeService,
  ],
  exports: [ComplianceService, AbrService],
})
export class ComplianceModule {}
