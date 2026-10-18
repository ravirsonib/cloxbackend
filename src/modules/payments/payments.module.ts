import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { TripsModule } from '../trips/trips.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';

@Module({
  imports: [JwtModule.register({}), AuditModule, forwardRef(() => TripsModule)],
  controllers: [PaymentsController],
  providers: [StripeService, PaymentsService, JwtAuthGuard, RolesGuard],
  exports: [StripeService, PaymentsService],
})
export class PaymentsModule {}
