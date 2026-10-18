import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AppRole,
  tripBreakSchema,
  tripLocationSchema,
  tripMassCheckSchema,
  tripSafetyCheckSchema,
  tripStartSchema,
  type TripBreakInput,
  type TripLocationInput,
  type TripMassCheckInput,
  type TripSafetyCheckInput,
  type TripStartInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { TripsService } from './trips.service';

@ApiTags('trips')
@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get('_status')
  @ApiOperation({ summary: 'Trips module status (M8/M9)' })
  status() {
    return { module: 'trips', status: 'ready', milestone: 'M9' };
  }

  @Get('mine')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Driver today / assigned trips' })
  mine(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.trips.listDriverTrips(principal);
  }

  @Get('jobs/:jobId/track')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SENDER)
  @ApiOperation({ summary: 'Sender tracking — only after Trip_Started' })
  track(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('jobId') jobId: string,
  ) {
    return this.trips.getSenderTracking(principal, jobId);
  }

  @Post('jobs/:jobId/start')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER, AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Start by jobId (driver only succeeds)' })
  startByJob(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(tripStartSchema)) body: TripStartInput,
  ) {
    return this.trips.startByJobId(principal, jobId, body);
  }

  @Get(':tripId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Driver trip detail + site access preview' })
  get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('tripId') tripId: string,
  ) {
    return this.trips.getDriverTrip(principal, tripId);
  }

  @Post(':tripId/safety-check')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Pre-trip safety checklist (fail locks vehicle)' })
  safety(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('tripId') tripId: string,
    @Body(new ZodValidationPipe(tripSafetyCheckSchema)) body: TripSafetyCheckInput,
  ) {
    return this.trips.safetyCheck(principal, tripId, body);
  }

  @Post(':tripId/mass-check')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Mass check — over declared blocks start (M9 surcharge)' })
  mass(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('tripId') tripId: string,
    @Body(new ZodValidationPipe(tripMassCheckSchema)) body: TripMassCheckInput,
  ) {
    return this.trips.massCheck(principal, tripId, body);
  }

  @Post(':tripId/start')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Start trip — paid + safety + mass; online-only' })
  start(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('tripId') tripId: string,
    @Body(new ZodValidationPipe(tripStartSchema)) body: TripStartInput,
  ) {
    return this.trips.startTrip(principal, tripId, body);
  }

  @Post(':tripId/break')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Taking break — pauses sender ETA/telemetry' })
  breakToggle(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('tripId') tripId: string,
    @Body(new ZodValidationPipe(tripBreakSchema)) body: TripBreakInput,
  ) {
    return this.trips.toggleBreak(principal, tripId, body);
  }

  @Post(':tripId/locations')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Post location sample (after start)' })
  location(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('tripId') tripId: string,
    @Body(new ZodValidationPipe(tripLocationSchema)) body: TripLocationInput,
  ) {
    return this.trips.postLocation(principal, tripId, body);
  }
}
