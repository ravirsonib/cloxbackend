import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ScopeService } from '../../common/services/scope.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';

@Module({
  imports: [JwtModule.register({}), AuditModule, NotificationsModule],
  controllers: [OpsController],
  providers: [OpsService, JwtAuthGuard, RolesGuard, StepUpGuard, ScopeService],
  exports: [OpsService, ScopeService],
})
export class OpsModule {}
