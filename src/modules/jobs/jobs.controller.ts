import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AppRole,
  jobCreateSchema,
  jobRouteEstimateSchema,
  type JobCreateInput,
  type JobRouteEstimateInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JobsService } from './jobs.service';
import {
  chargeableWeightKg,
  recommendVehicleClass,
  VEHICLE_CLASS_RANK,
} from './job-pricing.util';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get('_status')
  @ApiOperation({ summary: 'Jobs module status' })
  status() {
    return { module: 'jobs', status: 'ready', milestone: 'M6' };
  }

  @Get('meta/vehicle-classes')
  @ApiOperation({ summary: 'Vehicle class ranks + chargeable helper (FR-3)' })
  vehicleMeta() {
    return {
      classes: Object.keys(VEHICLE_CLASS_RANK),
      ranks: VEHICLE_CLASS_RANK,
      chargeableFormula: 'max(deadKg, L×W×Hcm/4000)',
    };
  }

  @Post('meta/recommend')
  @ApiOperation({ summary: 'Recommend vehicle class from dimensions' })
  recommend(
    @Body()
    body: { deadWeightKg: number; lengthCm: number; widthCm: number; heightCm: number },
  ) {
    const chargeable = chargeableWeightKg(body);
    const recommended = recommendVehicleClass(chargeable);
    return { chargeableWeightKg: chargeable, recommendedVehicleClass: recommended };
  }

  @Post('route-estimate')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({
    summary: 'Suggest distance/duration from pickup + drop (editable by sender on save)',
  })
  routeEstimate(
    @Body(new ZodValidationPipe(jobRouteEstimateSchema)) body: JobRouteEstimateInput,
  ) {
    return this.jobsService.previewRoute(body);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'List sender jobs' })
  list(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.jobsService.listSenderJobs(principal);
  }

  @Get(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Get job + masked proposals' })
  get(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.jobsService.getJobForSender(principal, id);
  }

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Create draft job (canBook required)' })
  create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(jobCreateSchema)) body: JobCreateInput,
  ) {
    return this.jobsService.createJob(principal, body);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Update DRAFT job (canBook required)' })
  update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(jobCreateSchema)) body: JobCreateInput,
  ) {
    return this.jobsService.updateJob(principal, id, body);
  }

  @Post(':id/publish')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Publish draft → BIDDING' })
  publish(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.jobsService.publishJob(principal, id);
  }

  @Post(':id/proposals/:proposalId/accept')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Accept proposal → PaymentIntent + assignment (M7 Model A)' })
  accept(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('proposalId') proposalId: string,
  ) {
    return this.jobsService.acceptProposal(principal, id, proposalId);
  }
}
