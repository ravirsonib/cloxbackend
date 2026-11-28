import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RateFloorModule } from '../rate-floor/rate-floor.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [JwtModule.register({}), AuditModule, NotificationsModule, RateFloorModule, SettlementsModule],
  controllers: [AdminController],
  providers: [AdminService, JwtAuthGuard, RolesGuard],
  exports: [AdminService],
})
export class AdminModule {}
