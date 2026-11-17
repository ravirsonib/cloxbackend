import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminRole,
  companyRevenueUpliftPublishSchema,
  companySenderFeeOverridePublishSchema,
  partnerPerformanceQuerySchema,
  revenueSplitAdminPackagePublishSchema,
  revenueSplitAdminPackagesQuerySchema,
  revenueSplitDraftSchema,
  revenueSplitOverridePublishSchema,
  revenueSplitPreviewQuerySchema,
  revenueSplitPublishSchema,
  type CompanyRevenueUpliftPublishInput,
  type CompanySenderFeeOverridePublishInput,
  type PartnerPerformanceQuery,
  type RevenueSplitAdminPackagePublishInput,
  type RevenueSplitAdminPackagesQuery,
  type RevenueSplitDraftInput,
  type RevenueSplitOverridePublishInput,
  type RevenueSplitPreviewQuery,
  type RevenueSplitPublishInput,
} from '../../shared/types';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedAdmin } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RevenueSplitService } from './revenue-split.service';

@ApiTags('admin-revenue-split')
@ApiBearerAuth()
@Controller('admin/settings/revenue-split')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPER_ADMIN)
export class RevenueSplitController {
  constructor(private readonly revenueSplit: RevenueSplitService) {}

  @Get()
  @ApiOperation({ summary: 'Effective + draft national revenue split (Super)' })
  getSettings() {
    return this.revenueSplit.getSettings();
  }

  @Get('versions')
  @ApiOperation({ summary: 'National revenue split version history' })
  listVersions() {
    return this.revenueSplit.listVersions();
  }

  @Get('scopes')
  @ApiOperation({ summary: 'Regions and territories (legacy override pickers)' })
  listScopes() {
    return this.revenueSplit.listScopes();
  }

  @Get('overrides')
  @ApiOperation({ summary: 'Legacy published region/territory overrides (audit)' })
  listOverrides() {
    return this.revenueSplit.listOverrides();
  }

  @Get('admin-packages')
  @ApiOperation({ summary: 'Published per-admin Super/State/Local packages' })
  listAdminPackages(
    @Query(new ZodValidationPipe(revenueSplitAdminPackagesQuerySchema))
    query: RevenueSplitAdminPackagesQuery,
  ) {
    return this.revenueSplit.listAdminPackages(query);
  }

  @Get('preview')
  @ApiOperation({ summary: 'Preview settlement lines for a sample gross' })
  preview(
    @Query(new ZodValidationPipe(revenueSplitPreviewQuerySchema))
    query: RevenueSplitPreviewQuery,
  ) {
    return this.revenueSplit.preview(query);
  }

  @Get('partner-performance')
  @ApiOperation({
    summary:
      'BoB + analytics for State/Local; decision support before publishing per-admin packages',
  })
  partnerPerformance(
    @Query(new ZodValidationPipe(partnerPerformanceQuerySchema))
    query: PartnerPerformanceQuery,
  ) {
    return this.revenueSplit.partnerPerformance(query);
  }

  @Post('draft')
  @ApiOperation({ summary: 'Create or update unpublished national draft' })
  saveDraft(
    @Body(new ZodValidationPipe(revenueSplitDraftSchema)) body: RevenueSplitDraftInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.revenueSplit.saveDraft(body, admin.id);
  }

  @Post('publish')
  @ApiOperation({ summary: 'Publish national revenue split (carrier % + CLOX pool)' })
  publish(
    @Body(new ZodValidationPipe(revenueSplitPublishSchema)) body: RevenueSplitPublishInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.revenueSplit.publishDraft(body, admin.id);
  }

  @Post('admin-packages')
  @ApiOperation({
    summary: 'Publish a personal CLOX-pool package for one State/Local admin (sum 100 of pool)',
  })
  publishAdminPackage(
    @Body(new ZodValidationPipe(revenueSplitAdminPackagePublishSchema))
    body: RevenueSplitAdminPackagePublishInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.revenueSplit.publishAdminPackage(body, admin.id);
  }

  @Get('carrier-uplifts/:companyId')
  @ApiOperation({ summary: 'List published carrier revenue uplifts for a company' })
  listCarrierUplifts(@Param('companyId', ParseUUIDPipe) companyId: string) {
    return this.revenueSplit.listCarrierUplifts(companyId);
  }

  @Post('carrier-uplifts')
  @ApiOperation({ summary: 'Publish per-carrier performance uplift (bonus % points)' })
  publishCarrierUplift(
    @Body(new ZodValidationPipe(companyRevenueUpliftPublishSchema))
    body: CompanyRevenueUpliftPublishInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.revenueSplit.publishCarrierUplift(body, admin.id);
  }

  @Get('sender-fee-overrides/:companyId')
  @ApiOperation({ summary: 'List published sender platform fee overrides' })
  listSenderFeeOverrides(@Param('companyId', ParseUUIDPipe) companyId: string) {
    return this.revenueSplit.listSenderFeeOverrides(companyId);
  }

  @Post('sender-fee-overrides')
  @ApiOperation({ summary: 'Publish per-sender platform fee % override' })
  publishSenderFeeOverride(
    @Body(new ZodValidationPipe(companySenderFeeOverridePublishSchema))
    body: CompanySenderFeeOverridePublishInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.revenueSplit.publishSenderFeeOverride(body, admin.id);
  }

  @Post('overrides')
  @ApiOperation({
    summary: 'Legacy: publish a region/territory override (prefer admin-packages)',
  })
  publishOverride(
    @Body(new ZodValidationPipe(revenueSplitOverridePublishSchema))
    body: RevenueSplitOverridePublishInput,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.revenueSplit.publishOverride(body, admin.id);
  }
}
