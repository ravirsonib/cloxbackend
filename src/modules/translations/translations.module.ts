import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TranslationsController } from './translations.controller';
import { TranslationsService } from './translations.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [TranslationsController],
  providers: [TranslationsService, JwtAuthGuard],
  exports: [TranslationsService],
})
export class TranslationsModule {}
