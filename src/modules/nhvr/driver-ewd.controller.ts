import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AppRole } from '../../shared/types';
import { NhvrService } from './nhvr.service';
import {
  manualRecordSchema,
  signDailySheetSchema,
  switchActivitySchema,
  type ManualRecordInput,
  type SignDailySheetInput,
  type SwitchActivityInput,
} from './nhvr.types';

@ApiTags('driver-ewd')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AppRole.DRIVER)
@Controller('driver/ewd')
export class DriverEwdController {
  constructor(private readonly nhvrService: NhvrService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get current EWD status & fatigue countdown' })
  getStatus(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.nhvrService.getStatus(principal.id);
  }

  @Post('activity')
  @ApiOperation({ summary: 'Switch EWD activity (WORK / REST)' })
  switchActivity(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(switchActivitySchema)) body: SwitchActivityInput,
  ) {
    return this.nhvrService.switchActivity(principal.id, body);
  }

  @Get('records')
  @ApiOperation({ summary: 'Get EWD work/rest history records' })
  getRecords(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query('days') days?: string,
  ) {
    const daysNum = days ? parseInt(days, 10) : 7;
    return this.nhvrService.getRecords(principal.id, daysNum);
  }

  @Post('records')
  @ApiOperation({ summary: 'Manual EWD entry / correction with reason' })
  createManualRecord(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(manualRecordSchema)) body: ManualRecordInput,
  ) {
    return this.nhvrService.createManualRecord(principal.id, body);
  }

  @Get('sheet/today')
  @ApiOperation({ summary: 'Get today 24-hour EWD sheet' })
  getTodaySheet(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.nhvrService.getTodaySheet(principal.id);
  }

  @Post('sheet/sign')
  @ApiOperation({ summary: 'Digitally sign daily sheet under s319 HVNL' })
  signDailySheet(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(signDailySheetSchema)) body: SignDailySheetInput,
  ) {
    return this.nhvrService.signDailySheet(principal.id, body);
  }

  @Post('roadside/pin')
  @ApiOperation({ summary: 'Generate temporary PIN for roadside inspection' })
  generateRoadsidePin(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.nhvrService.generateRoadsidePin(principal.id);
  }
}

