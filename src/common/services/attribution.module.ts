import { Global, Module } from '@nestjs/common';
import { AttributionService } from './attribution.service';

@Global()
@Module({
  providers: [AttributionService],
  exports: [AttributionService],
})
export class AttributionModule {}
