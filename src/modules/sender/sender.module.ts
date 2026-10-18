import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { PaymentsModule } from '../payments/payments.module';
import { SenderController } from './sender.controller';
import { SenderService } from './sender.service';

@Module({
  imports: [JwtModule.register({}), AuditModule, PaymentsModule],
  controllers: [SenderController],
  providers: [SenderService, JwtAuthGuard, RolesGuard],
  exports: [SenderService],
})
export class SenderModule {}
