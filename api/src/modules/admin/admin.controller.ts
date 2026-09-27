import {
  Body,
  Controller,
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
  adminAuditQuerySchema,
  adminLeadExportQuerySchema,
  adminLeadListQuerySchema,
  createLeadNoteSchema,
  updateLeadSchema,
  type AdminAuditQuery,
  type AdminLeadExportQuery,
  type AdminLeadListQuery,
  type CreateLeadNoteInput,
  type UpdateLeadInput,
} from '../../shared/types';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { JwtAuthGuard, type AuthenticatedAdmin } from '../../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AdminService } from './admin.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard)
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
