import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  AppRole,
  proposalSubmitSchema,
  carrierCapabilitiesSchema,
  carrierDriverInviteSchema,
  carrierDriverResendSchema,
  carrierProfileSchema,
  carrierRegisterSchema,
  carrierSubmitVerificationSchema,
  assignmentReassignSchema,
  carrierVehicleSchema,
  fleetDisableReasonSchema,
  type AssignmentReassignInput,
  type ProposalSubmitInput,
  type CarrierCapabilitiesInput,
  type CarrierDriverInviteInput,
  type CarrierDriverResendInput,
  type CarrierProfileInput,
  type CarrierRegisterInput,
  type CarrierSubmitVerificationInput,
  type CarrierVehicleInput,
  type FleetDisableReasonInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { MatchingService } from '../matching/matching.service';
import { CarrierService } from './carrier.service';

@ApiTags('carrier')
@Controller('carrier')
export class CarrierController {
  constructor(
    private readonly carrierService: CarrierService,
    private readonly matchingService: MatchingService,
  ) {}

  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register new transport company (then OTP login)' })
  register(@Body(new ZodValidationPipe(carrierRegisterSchema)) body: CarrierRegisterInput) {
    return this.carrierService.register(body);
  }

  @Get('onboarding')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Carrier onboarding status + go/no-go' })
  onboarding(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.carrierService.getOnboarding(principal);
  }

  @Put('profile')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Save legal entity profile' })
  profile(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(carrierProfileSchema)) body: CarrierProfileInput,
  ) {
    return this.carrierService.updateProfile(principal, body);
  }

  @Post('connect/setup')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Create Stripe Connect Express + Account Link (or mock)' })
  connectSetup(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.carrierService.createConnectOnboarding(principal);
  }

  @Post('connect/confirm')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Confirm Connect payouts enabled → continue wizard' })
  connectConfirm(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.carrierService.confirmConnect(principal);
  }

  @Get('vehicles')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'List company fleet vehicles' })
  listVehicles(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.carrierService.listVehicles(principal);
  }

  @Post('vehicles')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Add fleet vehicle (onboarding seed or post bid-eligible)' })
  addVehicle(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(carrierVehicleSchema)) body: CarrierVehicleInput,
  ) {
    return this.carrierService.addVehicle(principal, body);
  }

  @Post('vehicles/:id/disable')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Disable (suspend) a vehicle with reason' })
  disableVehicle(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(fleetDisableReasonSchema)) body: FleetDisableReasonInput,
  ) {
    return this.carrierService.disableVehicle(principal, id, body);
  }

  @Post('vehicles/:id/retire')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Retire a vehicle with reason' })
  retireVehicle(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(fleetDisableReasonSchema)) body: FleetDisableReasonInput,
  ) {
    return this.carrierService.retireVehicle(principal, id, body);
  }

  @Post('vehicles/:id/reactivate')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Reactivate a disabled or retired vehicle' })
  reactivateVehicle(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.carrierService.reactivateVehicle(principal, id);
  }

  @Delete('vehicles/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({
    summary: 'Permanently delete a never-assigned vehicle (unused fleet entry)',
  })
  deleteVehicle(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.carrierService.deleteVehicle(principal, id);
  }

  @Get('drivers')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'List company drivers' })
  listDrivers(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.carrierService.listDrivers(principal);
  }

  @Post('drivers/invite')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Invite driver with single-use token + email' })
  inviteDriver(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(carrierDriverInviteSchema)) body: CarrierDriverInviteInput,
  ) {
    return this.carrierService.inviteDriver(principal, body);
  }

  @Post('drivers/:id/disable')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Disable (suspend) a driver with reason' })
  disableDriver(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(fleetDisableReasonSchema)) body: FleetDisableReasonInput,
  ) {
    return this.carrierService.disableDriver(principal, id, body);
  }

  @Post('drivers/:id/reactivate')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Reactivate a disabled driver' })
  reactivateDriver(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.carrierService.reactivateDriver(principal, id);
  }

  @Delete('drivers/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({
    summary: 'Permanently delete a never-assigned driver (cancel invite / unused profile)',
  })
  deleteDriver(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.carrierService.deleteDriver(principal, id);
  }

  @Post('drivers/invite/resend')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Resend driver invite (new token)' })
  resendInvite(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(carrierDriverResendSchema)) body: CarrierDriverResendInput,
  ) {
    return this.carrierService.resendDriverInvite(principal, body);
  }

  @Put('capabilities')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Set capabilities + service regions' })
  capabilities(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(carrierCapabilitiesSchema)) body: CarrierCapabilitiesInput,
  ) {
    return this.carrierService.updateCapabilities(principal, body);
  }

  @Post('verification/submit')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Submit CARRIER_KYB docs for Ops review' })
  submit(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(carrierSubmitVerificationSchema))
    body: CarrierSubmitVerificationInput,
  ) {
    return this.carrierService.submitVerification(principal, body);
  }

  @Get('bid-eligibility')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Go/no-go: can bid?' })
  bidEligibility(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.carrierService.getBidEligibility(principal);
  }

  @Post('bids')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Submit bid (delegates to matching)' })
  bid(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(proposalSubmitSchema)) body: ProposalSubmitInput,
  ) {
    return this.matchingService.submitProposal(principal, body);
  }

  @Post('assignments/:id/reassign')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Reassign vehicle/driver on locked assignment with active trip' })
  reassignAssignment(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(assignmentReassignSchema)) body: AssignmentReassignInput,
  ) {
    return this.carrierService.reassignAssignment(principal, id, body);
  }
}
