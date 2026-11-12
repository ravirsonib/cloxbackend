import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AppRole,
  driverScheduleRequestSchema,
  type DriverScheduleRequestInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DriverScheduleService } from './driver-schedule.service';

@ApiTags('driver-schedule', 'driver-app')
@Controller('driver/schedule')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AppRole.DRIVER)
export class DriverScheduleController {
  constructor(private readonly scheduleService: DriverScheduleService) {}

  @Get()
  @ApiOperation({ summary: 'Get current driver schedule and time-off entries' })
  getMySchedule(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.scheduleService.getMySchedule(principal, { from, to });
  }

  @Post()
  @ApiOperation({ summary: 'Request time-off or set availability window' })
  requestTimeOff(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(driverScheduleRequestSchema)) body: DriverScheduleRequestInput,
  ) {
    return this.scheduleService.requestTimeOff(principal, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel pending or future scheduled time-off' })
  cancelTimeOff(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.scheduleService.cancelTimeOff(principal, id);
  }
}
