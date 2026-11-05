import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DriverController } from './driver.controller';
import { DriverScheduleController } from './driver-schedule.controller';
import { DriverService } from './driver.service';
import { DriverScheduleService } from './driver-schedule.service';

@Module({
  imports: [JwtModule.register({}), AuditModule, NotificationsModule],
  controllers: [DriverController, DriverScheduleController],
  providers: [DriverService, DriverScheduleService, JwtAuthGuard, RolesGuard],
  exports: [DriverService, DriverScheduleService],
})
export class DriverModule {}
