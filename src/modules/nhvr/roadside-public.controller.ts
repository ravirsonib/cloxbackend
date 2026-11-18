import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { NhvrRoadsideService } from './nhvr-roadside.service';
import { roadsideInspectSchema, type RoadsideInspectInput } from './nhvr.types';

@ApiTags('roadside-public')
@Controller('public/roadside')
export class RoadsidePublicController {
  constructor(private readonly roadsideService: NhvrRoadsideService) {}

  @Post('inspect')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Roadside inspector 28-day EWD audit by PIN' })
  inspect(@Body(new ZodValidationPipe(roadsideInspectSchema)) body: RoadsideInspectInput) {
    return this.roadsideService.inspectByPin(body.pin);
  }
}

