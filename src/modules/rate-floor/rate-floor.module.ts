import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RateFloorService } from './rate-floor.service';

@Module({
  imports: [NotificationsModule],
  providers: [RateFloorService],
  exports: [RateFloorService],
})
export class RateFloorModule {}
