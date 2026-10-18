import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('settlements')
@Controller('settlements')
export class SettlementsController {
  @Get('_status')
  @ApiOperation({ summary: 'Settlements module scaffold (M10+)' })
  status() {
    return {
      module: 'settlements',
      status: 'scaffold',
      milestone: 'M10',
      implemented: false,
    };
  }
}
