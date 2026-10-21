import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { CarrierModule } from '../carrier/carrier.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ExceptionEscalationWatchdog } from './exception-escalation.watchdog';
import { ExceptionsController } from './exceptions.controller';
import { ExceptionsService } from './exceptions.service';

@Module({
  imports: [
    JwtModule.register({}),
    AuditModule,
    NotificationsModule,
    forwardRef(() => CarrierModule),
  ],
  controllers: [ExceptionsController],
  providers: [
    ExceptionsService,
    ExceptionEscalationWatchdog,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [ExceptionsService],
})
export class ExceptionsModule {}
