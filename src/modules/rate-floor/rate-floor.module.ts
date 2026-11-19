import { Module } from '@nestjs/common';
import { RateFloorService } from './rate-floor.service';

@Module({
  providers: [RateFloorService],
  exports: [RateFloorService],
})
export class RateFloorModule {}
