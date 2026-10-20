import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminRole,
  adminAuditQuerySchema,
  adminCompanyListQuerySchema,
  adminLeadExportQuerySchema,
  adminLeadListQuerySchema,
  createLeadNoteSchema,
  disableCompanySchema,
  updateLeadSchema,
  type AdminAuditQuery,
  type AdminCompanyListQuery,
  type AdminLeadExportQuery,
  type AdminLeadListQuery,
  type CreateLeadNoteInput,
  type DisableCompanyInput,
  type UpdateLeadInput,
} from '../../shared/types';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedAdmin } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AdminService } from './admin.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPER_ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('dashboard/stats')
  @ApiOperation({ summary: 'Dashboard KPIs and recent activity' })
  getDashboardStats() {
    return this.adminService.getDashboardStats();
  }

  @Get('leads/export')
  @ApiOperation({ summary: 'Export leads as CSV' })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="clox-leads.csv"')
  exportLeads(
    @Query(new ZodValidationPipe(adminLeadExportQuerySchema)) query: AdminLeadExportQuery,
  ) {
    return this.adminService.exportLeadsCsv(query);
  }

  @Get('leads')
  @ApiOperation({ summary: 'List leads (paginated, filterable)' })
  listLeads(
    @Query(new ZodValidationPipe(adminLeadListQuerySchema)) query: AdminLeadListQuery,
  ) {
    return this.adminService.listLeads(query);
  }

  @Get('companies')
  @ApiOperation({ summary: 'List marketplace companies (senders + carriers)' })
  listCompanies(
    @Query(new ZodValidationPipe(adminCompanyListQuerySchema)) query: AdminCompanyListQuery,
  ) {
    return this.adminService.listCompanies(query);
  }

  @Post('companies/:id/disable')
  @ApiOperation({
    summary: 'Soft-disable (suspend) company + cascade users/drivers/vehicles (Super Admin)',
  })
  disableCompany(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(disableCompanySchema)) body: DisableCompanyInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.disableCompany(id, body, admin.id);
  }

  @Post('companies/:id/reactivate')
  @ApiOperation({ summary: 'Reactivate a suspended company (Super Admin)' })
  reactivateCompany(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.reactivateCompany(id, admin.id);
  }

  @Delete('companies/:id')
  @ApiOperation({ summary: 'Permanently delete a DRAFT company (Super Admin)' })
  deleteCompany(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.deleteCompany(id, admin.id);
  }

  @Get('leads/:id')
  @ApiOperation({ summary: 'Lead detail with notes and events' })
  getLead(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getLead(id);
  }

  @Patch('leads/:id')
  @ApiOperation({ summary: 'Update lead status / priority / assignee' })
  updateLead(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateLeadSchema)) body: UpdateLeadInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.updateLead(id, body, admin.id);
  }

  @Delete('leads/:id')
  @ApiOperation({ summary: 'Permanently delete a lead (Super Admin)' })
  deleteLead(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.deleteLead(id, admin.id);
  }

  @Post('leads/:id/notes')
  @ApiOperation({ summary: 'Add internal note to a lead' })
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createLeadNoteSchema)) body: CreateLeadNoteInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.addNote(id, body, admin.id);
  }

  @Get('audit')
  @ApiOperation({ summary: 'Activity / audit log' })
  listAudit(
    @Query(new ZodValidationPipe(adminAuditQuerySchema)) query: AdminAuditQuery,
  ) {
    return this.adminService.listAudit(query);
  }
}
