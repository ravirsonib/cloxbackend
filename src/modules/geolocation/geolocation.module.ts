import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { GeolocationController } from './geolocation.controller';
import { ValhallaClientService } from './valhalla-client.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [JwtModule.register({})],
  controllers: [GeolocationController],
  providers: [ValhallaClientService, RealtimeGateway],
  exports: [ValhallaClientService, RealtimeGateway],
})
export class GeolocationModule {}
