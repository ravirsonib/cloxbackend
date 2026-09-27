import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuditModule } from '../audit/audit.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [JwtModule.register({}), AuditModule],
  controllers: [AdminController],
  providers: [AdminService, JwtAuthGuard],
  exports: [AdminService],
})
export class AdminModule {}
