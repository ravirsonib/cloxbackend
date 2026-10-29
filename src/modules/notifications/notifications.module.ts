import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { InAppNotificationsService } from './in-app-notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [NotificationsController],
  providers: [NotificationsService, InAppNotificationsService, JwtAuthGuard, RolesGuard],
  exports: [NotificationsService, InAppNotificationsService],
})
export class NotificationsModule {}
