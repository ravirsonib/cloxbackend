import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  @Get('_status')
  @ApiOperation({ summary: 'Audit module scaffold (M0)' })
  status() {
    return { module: 'audit', status: 'ready', milestone: 'M0' };
  }
}
