import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { DriverModule } from '../driver/driver.module';
import { MatchingModule } from '../matching/matching.module';
import { PaymentsModule } from '../payments/payments.module';
import { CarrierController } from './carrier.controller';
import { CarrierService } from './carrier.service';

@Module({
  imports: [
    JwtModule.register({}),
    AuditModule,
    PaymentsModule,
    forwardRef(() => DriverModule),
    forwardRef(() => MatchingModule),
  ],
  controllers: [CarrierController],
  providers: [CarrierService, JwtAuthGuard, RolesGuard],
  exports: [CarrierService],
})
export class CarrierModule {}
