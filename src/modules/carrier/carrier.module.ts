import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CompanyProfileModule } from '../../common/services/company-profile.module';
import { AuditModule } from '../audit/audit.module';
import { DriverModule } from '../driver/driver.module';
import { MatchingModule } from '../matching/matching.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { CarrierController } from './carrier.controller';
import { CarrierService } from './carrier.service';
import { FleetMaintenanceService } from './fleet-maintenance.service';
import { FleetPlusService } from './fleet-plus.service';
import { FleetProfitService } from './fleet-profit.service';

@Module({
  imports: [
    JwtModule.register({}),
    AuditModule,
    PaymentsModule,
    NotificationsModule,
    CompanyProfileModule,
    forwardRef(() => DriverModule),
    forwardRef(() => MatchingModule),
  ],
  controllers: [CarrierController],
  providers: [
    CarrierService,
    FleetPlusService,
    FleetProfitService,
    FleetMaintenanceService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [CarrierService, FleetPlusService, FleetProfitService, FleetMaintenanceService],
})
export class CarrierModule {}
