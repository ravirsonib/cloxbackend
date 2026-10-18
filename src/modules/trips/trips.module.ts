import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { PaymentsModule } from '../payments/payments.module';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

@Module({
  imports: [JwtModule.register({}), AuditModule, forwardRef(() => PaymentsModule)],
  controllers: [TripsController],
  providers: [TripsService, JwtAuthGuard, RolesGuard],
  exports: [TripsService],
})
export class TripsModule {}
