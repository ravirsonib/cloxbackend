import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import {
  JwtAuthGuard,
  type AuthenticatedPrincipal,
} from '../../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  translationPreviewSchema,
  type TranslationPreviewInput,
} from '../../shared/types';
import { TranslationsService } from './translations.service';

@ApiTags('translations')
@Controller('translations')
export class TranslationsController {
  constructor(private readonly translations: TranslationsService) {}

  @Post('preview')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'On-read UGC translation preview (cached). Never overwrites source content.',
  })
  preview(
    @CurrentPrincipal() _principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(translationPreviewSchema))
    body: TranslationPreviewInput,
  ) {
    return this.translations.preview(body);
  }
}
