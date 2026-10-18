import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import {
  confirmDocumentSchema,
  createUploadIntentSchema,
  type ConfirmDocumentInput,
  type CreateUploadIntentInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DocumentsService } from './documents.service';

@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get('_status')
  @ApiOperation({ summary: 'Documents module status' })
  status() {
    return { module: 'documents', status: 'ready', milestone: 'M2' };
  }

  @Post('upload-intent')
  @ApiOperation({ summary: 'Create upload intent (mime/size validated; no malware scan)' })
  createIntent(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(createUploadIntentSchema)) body: CreateUploadIntentInput,
  ) {
    return this.documentsService.createUploadIntent(principal, body);
  }

  @Put(':id/content')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOperation({ summary: 'Upload document bytes (multipart field "file")' })
  putContent(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; size: number; originalname: string } | undefined,
  ) {
    return this.documentsService.putContent(principal, id, file);
  }

  @Post(':id/confirm')
  @ApiOperation({ summary: 'Confirm uploaded document content hash' })
  confirm(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(confirmDocumentSchema)) body: ConfirmDocumentInput,
  ) {
    return this.documentsService.confirm(principal, id, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Document metadata (no binary)' })
  getOne(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documentsService.getMetadata(principal, id);
  }
}
