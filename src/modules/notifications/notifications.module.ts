import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { FcmPushProvider } from './fcm-push.provider';
import { InAppNotificationsService } from './in-app-notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushDevicesService } from './push-devices.service';
import { PushDispatchService } from './push-dispatch.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    InAppNotificationsService,
    FcmPushProvider,
    PushDevicesService,
    PushDispatchService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [
    NotificationsService,
    InAppNotificationsService,
    PushDevicesService,
    PushDispatchService,
  ],
})
export class NotificationsModule {}
