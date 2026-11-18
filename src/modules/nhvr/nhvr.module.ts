import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { DriverEwdController } from './driver-ewd.controller';
import { NhvrCalculatorService } from './nhvr-calculator.service';
import { NhvrRoadsideService } from './nhvr-roadside.service';
import { NhvrService } from './nhvr.service';
import { RoadsidePublicController } from './roadside-public.controller';

@Module({
  imports: [JwtModule.register({}), PrismaModule],
  controllers: [DriverEwdController, RoadsidePublicController],
  providers: [
    NhvrService,
    NhvrCalculatorService,
    NhvrRoadsideService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [NhvrService, NhvrCalculatorService, NhvrRoadsideService],
})
export class NhvrModule {}

