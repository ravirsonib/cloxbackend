import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminRole,
  AppRole,
  tripExceptionContinueSchema,
  tripExceptionEscalateSchema,
  tripExceptionOpenSchema,
  tripExceptionReassignSchema,
  tripExceptionReleaseSchema,
  type TripExceptionContinueInput,
  type TripExceptionEscalateInput,
  type TripExceptionOpenInput,
  type TripExceptionReassignInput,
  type TripExceptionReleaseInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ExceptionsService } from './exceptions.service';

@ApiTags('exceptions')
@Controller('exceptions')
export class ExceptionsController {
  constructor(private readonly exceptions: ExceptionsService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.DRIVER)
  @ApiOperation({ summary: 'Driver opens sick-call / breakdown exception on a trip' })
  open(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(tripExceptionOpenSchema)) body: TripExceptionOpenInput,
  ) {
    return this.exceptions.open(principal, body);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Carrier exceptions inbox' })
  list(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.exceptions.listForCarrier(principal);
  }

  @Get('ops')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.STATE_MASTER)
  @ApiOperation({ summary: 'Ops read-only open/escalated exceptions queue' })
  listOps(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.exceptions.listForOps(principal);
  }

  @Get(':id/candidates')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({
    summary: 'Ranked intra-fleet rescue candidates (class / licence / proximity)',
  })
  candidates(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exceptions.listRescueCandidates(principal, id);
  }

  @Get(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AdminRole.SUPER_ADMIN,
    AdminRole.STATE_MASTER,
  )
  @ApiOperation({ summary: 'Exception detail' })
  get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exceptions.getForPrincipal(principal, id);
  }

  @Post(':id/reassign')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Carrier resolves exception via intra-fleet reassign' })
  reassign(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(tripExceptionReassignSchema)) body: TripExceptionReassignInput,
  ) {
    return this.exceptions.reassign(principal, id, body);
  }

  @Post(':id/continue')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Carrier resolves exception: repair & continue' })
  continueTrip(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(tripExceptionContinueSchema)) body: TripExceptionContinueInput,
  ) {
    return this.exceptions.continueTrip(principal, id, body);
  }

  @Post(':id/escalate')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Carrier escalates exception to Ops (notifies Ops + sender)' })
  escalate(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(tripExceptionEscalateSchema)) body: TripExceptionEscalateInput,
  ) {
    return this.exceptions.escalate(principal, id, body);
  }

  @Post(':id/release')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY, AdminRole.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Release to marketplace (priority re-list + configurable carrier discount; Super or carrier)',
  })
  release(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(tripExceptionReleaseSchema)) body: TripExceptionReleaseInput,
  ) {
    return this.exceptions.releaseToMarketplace(principal, id, body);
  }
}
