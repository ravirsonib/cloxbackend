import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';

@Module({
  imports: [JwtModule.register({}), AuditModule, NotificationsModule],
  controllers: [DriverController],
  providers: [DriverService, JwtAuthGuard, RolesGuard],
  exports: [DriverService],
})
export class DriverModule {}
