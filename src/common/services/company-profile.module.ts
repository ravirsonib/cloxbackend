import { Module } from '@nestjs/common';
import { AuditModule } from '../../modules/audit/audit.module';
import { CompanyProfileService } from './company-profile.service';

@Module({
  imports: [AuditModule],
  providers: [CompanyProfileService],
  exports: [CompanyProfileService],
})
export class CompanyProfileModule {}
