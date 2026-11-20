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
  adminDashboardQuerySchema,
  adminJobListQuerySchema,
  adminLeadExportQuerySchema,
  adminLeadListQuerySchema,
  createLeadNoteSchema,
  disableCompanySchema,
  platformSettingsPatchSchema,
  updateLeadSchema,
  vehicleClassCreateSchema,
  vehicleClassUpdateSchema,
  rateFloorDraftCreateSchema,
  rateFloorLinePatchSchema,
  rateFloorBodyPatchSchema,
  rateFloorChecksQuerySchema,
  fuelIndexCreateSchema,
  rateFloorOverrideCreateSchema,
  publicHolidayUpsertSchema,
  type AdminAuditQuery,
  type AdminCompanyListQuery,
  type AdminDashboardQuery,
  type AdminJobListQuery,
  type AdminLeadExportQuery,
  type AdminLeadListQuery,
  type CreateLeadNoteInput,
  type DisableCompanyInput,
  type PlatformSettingsPatchInput,
  type UpdateLeadInput,
  type VehicleClassCreateInput,
  type VehicleClassUpdateInput,
  type RateFloorDraftCreateInput,
  type RateFloorLinePatchInput,
  type RateFloorBodyPatchInput,
  type RateFloorChecksQuery,
  type FuelIndexCreateInput,
  type RateFloorOverrideCreateInput,
  type PublicHolidayUpsertInput,
} from '../../shared/types';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedAdmin } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RateFloorService } from '../rate-floor/rate-floor.service';
import { AdminService } from './admin.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPER_ADMIN)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly rateFloor: RateFloorService,
  ) {}

  @Get('dashboard/stats')
  @ApiOperation({ summary: 'Dashboard KPIs and recent activity' })
  getDashboardStats(
    @Query(new ZodValidationPipe(adminDashboardQuerySchema)) query?: AdminDashboardQuery,
  ) {
    return this.adminService.getDashboardStats(query);
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
  @ApiOperation({ summary: 'List marketplace customers (filter by sender or carrier; default carrier)' })
  listCompanies(
    @Query(new ZodValidationPipe(adminCompanyListQuerySchema)) query: AdminCompanyListQuery,
  ) {
    return this.adminService.listCompanies(query);
  }

  @Get('companies/:id')
  @ApiOperation({
    summary:
      'Get full company details including company docs, fleet with vehicle docs, and drivers with driver docs',
  })
  getCompany(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getCompany(id);
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

  @Get('jobs')
  @ApiOperation({ summary: 'List all marketplace jobs (Super Admin)' })
  listJobs(
    @Query(new ZodValidationPipe(adminJobListQuerySchema)) query: AdminJobListQuery,
  ) {
    return this.adminService.listJobs(query);
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Job detail (Super Admin)' })
  getJob(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getJob(id);
  }

  @Delete('jobs/:id')
  @ApiOperation({
    summary: 'Hard-delete DRAFT/CANCELLED/EXPIRED job (Super Admin)',
  })
  hardDeleteJob(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.hardDeleteJob(id, admin.id);
  }

  @Post('jobs/:id/soft-delete')
  @ApiOperation({
    summary: 'Soft-delete (cancel) an active job — keeps payment history (Super Admin)',
  })
  softDeleteJob(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.softDeleteJob(id, admin.id);
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

  @Get('platform-settings')
  @ApiOperation({
    summary: 'Marketplace rescue discount / SLA / reliability deltas (Super Admin)',
  })
  getPlatformSettings() {
    return this.adminService.getPlatformSettings();
  }

  @Patch('platform-settings')
  @ApiOperation({ summary: 'Update platform rescue settings (Super Admin)' })
  patchPlatformSettings(
    @Body(new ZodValidationPipe(platformSettingsPatchSchema)) body: PlatformSettingsPatchInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.patchPlatformSettings(body, admin.id);
  }

  @Get('vehicle-classes')
  @ApiOperation({ summary: 'List all configured vehicle classes (Super Admin)' })
  listVehicleClasses() {
    return this.adminService.listVehicleClasses();
  }

  @Post('vehicle-classes')
  @ApiOperation({ summary: 'Create a new vehicle class (Super Admin)' })
  createVehicleClass(
    @Body(new ZodValidationPipe(vehicleClassCreateSchema)) body: VehicleClassCreateInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.createVehicleClass(body, admin.id);
  }

  @Patch('vehicle-classes/:id')
  @ApiOperation({ summary: 'Update a vehicle class (Super Admin)' })
  updateVehicleClass(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(vehicleClassUpdateSchema)) body: VehicleClassUpdateInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.updateVehicleClass(id, body, admin.id);
  }

  @Delete('vehicle-classes/:id')
  @ApiOperation({ summary: 'Delete a vehicle class if unused (Super Admin)' })
  deleteVehicleClass(
    @Param('id') id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminService.deleteVehicleClass(id, admin.id);
  }

  @Get('rate-floor/versions')
  @ApiOperation({ summary: 'List rate floor versions (Super Admin)' })
  listRateFloorVersions() {
    return this.rateFloor.listVersions();
  }

  @Get('rate-floor/versions/:id')
  @ApiOperation({ summary: 'Get a rate floor version with lines' })
  getRateFloorVersion(@Param('id', ParseUUIDPipe) id: string) {
    return this.rateFloor.getVersion(id);
  }

  @Post('rate-floor/versions')
  @ApiOperation({ summary: 'Create DRAFT floor version from current PUBLISHED' })
  createRateFloorDraft(
    @Body(new ZodValidationPipe(rateFloorDraftCreateSchema)) body: RateFloorDraftCreateInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.rateFloor.createDraftFromPublished(admin.id, body.label);
  }

  @Patch('rate-floor/versions/:id/lines/:code')
  @ApiOperation({ summary: 'Update a DRAFT floor line by vehicle class code' })
  patchRateFloorLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('code') code: string,
    @Body(new ZodValidationPipe(rateFloorLinePatchSchema)) body: RateFloorLinePatchInput,
  ) {
    return this.rateFloor.updateDraftLine(id, code, body);
  }

  @Patch('rate-floor/versions/:id/body/:code')
  @ApiOperation({ summary: 'Update a DRAFT body loading % / minHours (W3.4)' })
  patchRateFloorBody(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('code') code: string,
    @Body(new ZodValidationPipe(rateFloorBodyPatchSchema)) body: RateFloorBodyPatchInput,
  ) {
    return this.rateFloor.updateDraftBodyLoading(id, code, body);
  }

  @Post('rate-floor/versions/:id/submit-approval')
  @ApiOperation({ summary: 'Creator submits DRAFT for dual-approve publish (Wave 2.6)' })
  submitRateFloorApproval(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.rateFloor.submitForApproval(id, admin.id);
  }

  @Post('rate-floor/versions/:id/withdraw-approval')
  @ApiOperation({ summary: 'Creator withdraws pending approval so draft can be edited' })
  withdrawRateFloorApproval(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.rateFloor.withdrawApproval(id, admin.id);
  }

  @Post('rate-floor/versions/:id/publish')
  @ApiOperation({
    summary:
      'Second Super publishes submitted DRAFT (≠ creator). Retires previous PUBLISHED.',
  })
  publishRateFloorVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.rateFloor.publishDraft(id, admin.id);
  }

  @Get('rate-floor/checks')
  @ApiOperation({ summary: 'List rate-floor check audit rows (Super Admin)' })
  listRateFloorChecks(
    @Query(new ZodValidationPipe(rateFloorChecksQuerySchema)) query: RateFloorChecksQuery,
  ) {
    return this.rateFloor.listChecks(query);
  }

  @Get('rate-floor/checks/export')
  @ApiOperation({ summary: 'Export rate-floor checks as CSV (W3.4)' })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="clox-rate-floor-checks.csv"')
  exportRateFloorChecks(
    @Query(new ZodValidationPipe(rateFloorChecksQuerySchema)) query: RateFloorChecksQuery,
  ) {
    return this.rateFloor.exportChecksCsv(query);
  }

  @Get('rate-floor/overrides')
  @ApiOperation({ summary: 'List rate-floor job overrides (Super Admin)' })
  listRateFloorOverrides(
    @Query('jobId') jobId?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.rateFloor.listOverrides({
      jobId,
      activeOnly: activeOnly === '1' || activeOnly === 'true',
    });
  }

  @Post('rate-floor/overrides')
  @ApiOperation({ summary: 'Create time-limited per-job floor override (Super Admin)' })
  createRateFloorOverride(
    @Body(new ZodValidationPipe(rateFloorOverrideCreateSchema)) body: RateFloorOverrideCreateInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.rateFloor.createOverride(admin.id, body);
  }

  @Post('rate-floor/overrides/:id/expire')
  @ApiOperation({ summary: 'Expire a rate-floor override now (W3.4)' })
  expireRateFloorOverride(@Param('id', ParseUUIDPipe) id: string) {
    return this.rateFloor.expireOverride(id);
  }

  @Get('public-holidays')
  @ApiOperation({
    summary:
      'List public holidays for labour period (Wave 2.7). Multiplier = Sunday stub until Award confirms.',
  })
  async listPublicHolidays(@Query('state') state?: string) {
    await this.rateFloor.ensurePublicHolidaySeed();
    return this.rateFloor.listPublicHolidays({ state });
  }

  @Post('public-holidays')
  @ApiOperation({ summary: 'Upsert a public holiday (state|NATIONAL + date)' })
  upsertPublicHoliday(
    @Body(new ZodValidationPipe(publicHolidayUpsertSchema)) body: PublicHolidayUpsertInput,
  ) {
    return this.rateFloor.upsertPublicHoliday(body);
  }

  @Delete('public-holidays/:id')
  @ApiOperation({ summary: 'Delete a public holiday row' })
  deletePublicHoliday(@Param('id', ParseUUIDPipe) id: string) {
    return this.rateFloor.deletePublicHoliday(id);
  }

  @Get('fuel-index/status')
  @ApiOperation({ summary: 'Latest diesel index + stale banner flags (Super Admin)' })
  getFuelIndexStatus() {
    return this.rateFloor.getFuelStatus();
  }

  @Get('fuel-index')
  @ApiOperation({ summary: 'List weekly diesel fuel index history (Super Admin)' })
  listFuelIndex() {
    return this.rateFloor.listFuelIndexes();
  }

  @Post('fuel-index')
  @ApiOperation({
    summary:
      'Enter weekly national average retail diesel (c/L). Large week-over-week moves require confirm=true.',
  })
  createFuelIndex(
    @Body(new ZodValidationPipe(fuelIndexCreateSchema)) body: FuelIndexCreateInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.rateFloor.createFuelIndex(admin.id, body);
  }
}
