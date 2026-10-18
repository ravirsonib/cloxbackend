import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { PaymentsModule } from '../payments/payments.module';
import { SenderModule } from '../sender/sender.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  imports: [JwtModule.register({}), AuditModule, SenderModule, PaymentsModule],
  controllers: [JobsController],
  providers: [JobsService, JwtAuthGuard, RolesGuard],
  exports: [JobsService],
})
export class JobsModule {}
