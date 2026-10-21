import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ScopeService } from '../../common/services/scope.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GrowthController, GrowthPublicController } from './growth.controller';
import { GrowthService } from './growth.service';

@Module({
  imports: [JwtModule.register({}), AuditModule, NotificationsModule],
  controllers: [GrowthController, GrowthPublicController],
  providers: [GrowthService, JwtAuthGuard, RolesGuard, ScopeService],
  exports: [GrowthService],
})
export class GrowthModule {}
