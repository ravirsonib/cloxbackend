import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminRole,
  AppRole,
  assignDisputeSchema,
  closeLocalDisputeSchema,
  createDisputeSchema,
  escalateDisputeSchema,
  listDisputesQuerySchema,
  resolveDisputeSchema,
  triageDisputeSchema,
  type AssignDisputeInput,
  type CloseLocalDisputeInput,
  type CreateDisputeInput,
  type EscalateDisputeInput,
  type ListDisputesQuery,
  type ResolveDisputeInput,
  type TriageDisputeInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DisputesService } from './disputes.service';

@ApiTags('disputes')
@ApiBearerAuth()
@Controller('disputes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Post()
  @Roles(AppRole.SENDER, AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Open a formal dispute on a job, trip, or surcharge' })
  create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(createDisputeSchema)) body: CreateDisputeInput,
  ) {
    return this.disputesService.create(principal, body);
  }

  @Get()
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.STATE_MASTER,
    AdminRole.LOCAL_BDE,
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
  )
  @ApiOperation({ summary: 'List disputes (scoped by role / region / territory / company)' })
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(listDisputesQuerySchema)) query: ListDisputesQuery,
  ) {
    return this.disputesService.list(principal, query);
  }

  @Get(':id')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.STATE_MASTER,
    AdminRole.LOCAL_BDE,
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
  )
  @ApiOperation({ summary: 'Get dispute details with full timeline and evidence' })
  getById(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.disputesService.getById(principal, id);
  }

  @Post(':id/triage')
  @Roles(AdminRole.LOCAL_BDE, AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Local BDE first-line triage checklist update (OPS-LOC-DSP-02)' })
  triage(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(triageDisputeSchema)) body: TriageDisputeInput,
  ) {
    return this.disputesService.triage(principal, id, body);
  }

  @Post(':id/escalate')
  @Roles(AdminRole.LOCAL_BDE, AdminRole.STATE_MASTER, AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Escalate dispute (Local -> State, or State -> Super)' })
  escalate(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(escalateDisputeSchema)) body: EscalateDisputeInput,
  ) {
    return this.disputesService.escalate(principal, id, body);
  }

  @Post(':id/assign')
  @Roles(AdminRole.STATE_MASTER, AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Assign dispute to a Local BDE for evidence gathering (OPS-STA-DSP-02)' })
  assign(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(assignDisputeSchema)) body: AssignDisputeInput,
  ) {
    return this.disputesService.assign(principal, id, body);
  }

  @Post(':id/resolve')
  @Roles(AdminRole.STATE_MASTER, AdminRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Adjudicate dispute with binding ruling & financial adjustment hooks (OPS-*-DSP-02)',
  })
  resolve(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(resolveDisputeSchema)) body: ResolveDisputeInput,
  ) {
    return this.disputesService.resolve(principal, id, body);
  }

  @Post(':id/close-local')
  @Roles(AdminRole.LOCAL_BDE, AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Close dispute locally after informal triage agreement' })
  closeLocal(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(closeLocalDisputeSchema)) body: CloseLocalDisputeInput,
  ) {
    return this.disputesService.closeLocal(principal, id, body);
  }
}
