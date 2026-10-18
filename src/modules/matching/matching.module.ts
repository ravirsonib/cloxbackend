import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../audit/audit.module';
import { CarrierModule } from '../carrier/carrier.module';
import { JobsModule } from '../jobs/jobs.module';
import { MatchingController } from './matching.controller';
import { MatchingService } from './matching.service';

@Module({
  imports: [
    JwtModule.register({}),
    AuditModule,
    forwardRef(() => CarrierModule),
    JobsModule,
  ],
  controllers: [MatchingController],
  providers: [MatchingService, JwtAuthGuard, RolesGuard],
  exports: [MatchingService],
})
export class MatchingModule {}
