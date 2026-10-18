import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [IdentityController],
  providers: [IdentityService, JwtAuthGuard],
  exports: [IdentityService],
})
export class IdentityModule {}
