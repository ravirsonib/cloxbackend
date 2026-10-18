import { Module } from '@nestjs/common';
import { GeolocationController } from './geolocation.controller';

@Module({
  controllers: [GeolocationController],
})
export class GeolocationModule {}
