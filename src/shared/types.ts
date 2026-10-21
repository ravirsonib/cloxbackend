import { z } from 'zod';

export const LeadType = {
  REGISTRY_SENDER: 'REGISTRY_SENDER',
  REGISTRY_CARRIER: 'REGISTRY_CARRIER',
  EOI_STATE_MASTER: 'EOI_STATE_MASTER',
  EOI_LOCAL_BDE: 'EOI_LOCAL_BDE',
  INVESTOR: 'INVESTOR',
} as const;

export type LeadType = (typeof LeadType)[keyof typeof LeadType];

export const LeadStatus = {
  NEW: 'NEW',
  CONTACTED: 'CONTACTED',
  QUALIFIED: 'QUALIFIED',
  INVITED: 'INVITED',
  ONBOARDED: 'ONBOARDED',
  REJECTED: 'REJECTED',
  DUPLICATE: 'DUPLICATE',
  UNDER_REVIEW: 'UNDER_REVIEW',
  KYB_PENDING: 'KYB_PENDING',
  EXECUTIVE_REVIEW: 'EXECUTIVE_REVIEW',
  APPROVED: 'APPROVED',
  AGREEMENT_SENT: 'AGREEMENT_SENT',
  PROVISIONED: 'PROVISIONED',
} as const;

export type LeadStatus = (typeof LeadStatus)[keyof typeof LeadStatus];

export const AdminRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  STATE_MASTER: 'STATE_MASTER',
  LOCAL_BDE: 'LOCAL_BDE',
} as const;

export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

export const PlatformRole = {
  SENDER: 'SENDER',
  TRANSPORT_COMPANY: 'TRANSPORT_COMPANY',
  DRIVER: 'DRIVER',
} as const;

export type PlatformRole = (typeof PlatformRole)[keyof typeof PlatformRole];

/** All six Phase 1 login roles. */
export const AppRole = {
  ...AdminRole,
  ...PlatformRole,
} as const;

export type AppRole = (typeof AppRole)[keyof typeof AppRole];

export const ADMIN_ROLES: AdminRole[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.STATE_MASTER,
  AdminRole.LOCAL_BDE,
];

export function isAdminRole(role: string): role is AdminRole {
  return (ADMIN_ROLES as string[]).includes(role);
}

export const Locale = {
  en: 'en',
  hi: 'hi',
  pa: 'pa',
} as const;

export type Locale = (typeof Locale)[keyof typeof Locale];

export const AuditAction = {
  LEAD_CREATED: 'lead.created',
  LEAD_STATUS_CHANGED: 'lead.status_changed',
  LEAD_UPDATED: 'lead.updated',
  LEAD_NOTE_ADDED: 'lead.note_added',
  LEAD_DELETED: 'lead.deleted',
  AUTH_OTP_REQUESTED: 'auth.otp_requested',
  AUTH_OTP_VERIFIED: 'auth.otp_verified',
  AUTH_OTP_FAILED: 'auth.otp_failed',
  AUTH_TOKEN_REFRESHED: 'auth.token_refreshed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_SESSION_REVOKED: 'auth.session_revoked',
  AUTH_STEP_UP_REQUESTED: 'auth.step_up_requested',
  AUTH_STEP_UP_VERIFIED: 'auth.step_up_verified',
  ADMIN_PROVISIONED: 'admin.provisioned',
  ADMIN_INVITED: 'admin.invited',
  ADMIN_INVITE_RESENT: 'admin.invite_resent',
  ADMIN_INVITE_ACCEPTED: 'admin.invite_accepted',
  ADMIN_PARTNER_SUBMITTED: 'admin.partner_submitted',
  ADMIN_PARTNER_ACTIVATED: 'admin.partner_activated',
  ADMIN_SCOPE_CHANGED: 'admin.scope_changed',
  DOC_UPLOAD_INTENT: 'document.upload_intent',
  DOC_UPLOADED: 'document.uploaded',
  DOC_CONFIRMED: 'document.confirmed',
  COMPLIANCE_SUBMITTED: 'compliance.submitted',
  COMPLIANCE_APPROVED: 'compliance.approved',
  COMPLIANCE_REJECTED: 'compliance.rejected',
  COMPLIANCE_INFO_REQUESTED: 'compliance.info_requested',
  COMPLIANCE_ESCALATED: 'compliance.escalated',
  COMPLIANCE_DOC_EXPIRED: 'compliance.doc_expired',
  COMPANY_SUSPENDED: 'company.suspended',
  COMPANY_REACTIVATED: 'company.reactivated',
  COMPANY_DELETED: 'company.deleted',
  COMPANY_INVITE_SENT: 'company.invite_sent',
  COMPANY_INVITE_RESENT: 'company.invite_resent',
  COMPANY_INVITE_ACCEPTED: 'company.invite_accepted',
  COMPANY_REFERRER_REASSIGNED: 'company.referrer_reassigned',
  PROSPECT_CREATED: 'prospect.created',
  PROSPECT_UPDATED: 'prospect.updated',
  SENDER_REGISTERED: 'sender.registered',
  SENDER_PROFILE_UPDATED: 'sender.profile_updated',
  SENDER_PAYMENT_SETUP: 'sender.payment_setup',
  SENDER_PAYMENT_READY: 'sender.payment_ready',
  SENDER_ACTIVATED: 'sender.activated',
  CARRIER_REGISTERED: 'carrier.registered',
  CARRIER_PROFILE_UPDATED: 'carrier.profile_updated',
  CARRIER_CONNECT_SETUP: 'carrier.connect_setup',
  CARRIER_CONNECT_READY: 'carrier.connect_ready',
  CARRIER_VEHICLE_ADDED: 'carrier.vehicle_added',
  CARRIER_VEHICLE_DISABLED: 'carrier.vehicle_disabled',
  CARRIER_VEHICLE_RETIRED: 'carrier.vehicle_retired',
  CARRIER_VEHICLE_REACTIVATED: 'carrier.vehicle_reactivated',
  CARRIER_VEHICLE_DELETED: 'carrier.vehicle_deleted',
  CARRIER_DRIVER_INVITED: 'carrier.driver_invited',
  CARRIER_DRIVER_INVITE_RESENT: 'carrier.driver_invite_resent',
  CARRIER_DRIVER_DISABLED: 'carrier.driver_disabled',
  CARRIER_DRIVER_REACTIVATED: 'carrier.driver_reactivated',
  CARRIER_DRIVER_DELETED: 'carrier.driver_deleted',
  CARRIER_CAPABILITIES_UPDATED: 'carrier.capabilities_updated',
  CARRIER_ACTIVATED: 'carrier.activated',
  DRIVER_INVITE_ACCEPTED: 'driver.invite_accepted',
  DRIVER_PROFILE_SUBMITTED: 'driver.profile_submitted',
  DRIVER_ACTIVATED: 'driver.activated',
  DRIVER_SUSPENDED: 'driver.suspended',
  JOB_CREATED: 'job.created',
  JOB_UPDATED: 'job.updated',
  JOB_PUBLISHED: 'job.published',
  PROPOSAL_SUBMITTED: 'proposal.submitted',
  PROPOSAL_ACCEPTED: 'proposal.accepted',
  PROPOSAL_EXPIRED_CONFLICT: 'proposal.expired_conflict',
  PAYMENT_INTENT_CREATED: 'payment.intent_created',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  ASSIGNMENT_LOCKED: 'assignment.locked',
  ASSIGNMENT_REASSIGNED: 'assignment.reassigned',
  EXCEPTION_OPENED: 'exception.opened',
  EXCEPTION_NOTIFIED: 'exception.notified',
  EXCEPTION_REASSIGNED: 'exception.reassigned',
  EXCEPTION_ESCALATED: 'exception.escalated',
  EXCEPTION_RELEASED: 'exception.released',
  EXCEPTION_RESOLVED: 'exception.resolved',
  EXCEPTION_PERFORMANCE_STUB: 'exception.performance_stub',
  REFUND_STUB: 'payment.refund_stub',
  TRIP_CREATED: 'trip.created',
  TRIP_SAFETY_PASSED: 'trip.safety_passed',
  TRIP_SAFETY_FAILED: 'trip.safety_failed',
  TRIP_MASS_CHECKED: 'trip.mass_checked',
  TRIP_STARTED: 'trip.started',
  TRIP_BREAK_TOGGLED: 'trip.break_toggled',
  TRIP_LOCATION: 'trip.location',
  TRIP_GEOFENCE_ENTER: 'trip.geofence_enter',
  TRIP_GEOFENCE_EXIT: 'trip.geofence_exit',
  TRIP_COMPLETED: 'trip.completed',
  SURCHARGE_CREATED: 'surcharge.created',
  SURCHARGE_PAID: 'surcharge.paid',
  SURCHARGE_WAIVED: 'surcharge.waived',
  PUSH_STUB: 'notify.push_stub',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

const honeypotField = z.string().max(200).optional();
const localeField = z.enum(['en', 'hi', 'pa', 'ru']).default('en');
const abnField = z
  .string()
  .trim()
  .regex(/^\d{2}\s?\d{3}\s?\d{3}\s?\d{3}$|^\d{9,11}$/, 'Invalid ABN format');
const emailField = z
  .string()
  .trim()
  .email()
  .transform((value) => value.toLowerCase());

const PHONE_MESSAGE = 'Enter a valid Australian phone number (e.g. 04xx xxx xxx or +61…)';

/** AU-friendly phone: formatting chars only; rejects letters/junk; +61 or 0… digits. */
const phoneField = z
  .string()
  .trim()
  .min(8, PHONE_MESSAGE)
  .max(30, PHONE_MESSAGE)
  .refine((value) => /^[+\d\s().\-]+$/.test(value), PHONE_MESSAGE)
  .refine((value) => {
    const digits = value.replace(/\D/g, '');
    if (/^61\d{8,10}$/.test(digits)) return true;
    if (/^0\d{8,10}$/.test(digits)) return true;
    return false;
  }, PHONE_MESSAGE);

const ORG_NAME_MESSAGE =
  'Use letters, numbers, and common punctuation only (e.g. Pty Ltd, & Co.)';
const PERSON_NAME_MESSAGE = 'Use letters and common name punctuation only';

function organizationNameField(min = 2, max = 200) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N}\s.'&\-()/]*$/u, ORG_NAME_MESSAGE);
}

function personNameField(min = 2, max = 120) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[\p{L}][\p{L}\s.'\-]*$/u, PERSON_NAME_MESSAGE);
}

const acceptedTrue = z.preprocess(
  (value) => value === true || value === 'true' || value === 'on' || value === 1 || value === '1',
  z.literal(true),
);

export const leadTypeSchema = z.enum([
  LeadType.REGISTRY_SENDER,
  LeadType.REGISTRY_CARRIER,
  LeadType.EOI_STATE_MASTER,
  LeadType.EOI_LOCAL_BDE,
  LeadType.INVESTOR,
]);

export const leadStatusSchema = z.enum([
  LeadStatus.NEW,
  LeadStatus.CONTACTED,
  LeadStatus.QUALIFIED,
  LeadStatus.INVITED,
  LeadStatus.ONBOARDED,
  LeadStatus.REJECTED,
  LeadStatus.DUPLICATE,
  LeadStatus.UNDER_REVIEW,
  LeadStatus.KYB_PENDING,
  LeadStatus.EXECUTIVE_REVIEW,
  LeadStatus.APPROVED,
  LeadStatus.AGREEMENT_SENT,
  LeadStatus.PROVISIONED,
]);

export const registrySenderSchema = z.object({
  userType: z.literal('sender'),
  companyLegalName: organizationNameField(),
  abn: abnField,
  shippingOrigin: z.string().trim().min(2).max(120),
  operationalModels: z.array(z.string().min(1)).min(1),
  biddingType: z.array(z.string().min(1)).min(1),
  monthlyVolume: z.string().trim().min(1),
  infraAcknowledged: z.array(z.string()).default([]),
  email: emailField,
  phone: phoneField,
  locale: localeField,
  source: z.string().trim().max(200).optional(),
  honeypot: honeypotField,
});

export const registryCarrierSchema = z.object({
  userType: z.literal('carrier'),
  fleetEntityName: organizationNameField(2, 200),
  abn: abnField,
  depotState: z.string().trim().min(2).max(80),
  fleetComposition: z.array(z.string().min(1)).min(1),
  capabilities: z.array(z.string()).default([]),
  complianceAuthorized: acceptedTrue,
  infraAcknowledged: z.array(z.string()).default([]),
  email: emailField,
  phone: phoneField,
  locale: localeField,
  source: z.string().trim().max(200).optional(),
  honeypot: honeypotField,
});

export const registryLeadSchema = z.discriminatedUnion('userType', [
  registrySenderSchema,
  registryCarrierSchema,
]);

export type RegistryLeadInput = z.infer<typeof registryLeadSchema>;

export const eoiLeadSchema = z.object({
  role: z.enum(['state_master', 'local_bde']),
  targetState: z.string().trim().min(2).max(80),
  targetTerritory: z.string().trim().min(2).max(120),
  fullLegalName: personNameField(),
  companyName: organizationNameField(),
  abn: abnField,
  acn: z.string().trim().max(20).optional(),
  email: emailField,
  phone: phoneField,
  corporateAddress: z.string().trim().min(5).max(300),
  networkExperience: z.string().trim().min(10).max(4000),
  executionStrategy: z.string().trim().min(10).max(4000),
  declarationAccepted: acceptedTrue,
  locale: localeField,
  source: z.string().trim().max(200).optional(),
  honeypot: honeypotField,
});

export type EoiLeadInput = z.infer<typeof eoiLeadSchema>;

export const investorClassificationSchema = z.enum([
  'sophisticated_investor',
  'professional_investor',
  'strategic_industry_partner',
]);

export const capitalAllocationSchema = z.enum([
  '25000_99999',
  '100000_249999',
  '250000_499999',
  '500000_plus',
]);

export const ecosystemFocusSchema = z.enum([
  'pure_financial_growth',
  'strategic_carrier_fleet',
  'enterprise_sender_pipeline',
  'regional_admin_network',
]);

export const investorLeadSchema = z.object({
  fullNameOrEntity: organizationNameField(2, 200),
  contactPersonName: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim().length === 0 ? undefined : value,
    personNameField(2, 120).optional(),
  ),
  email: emailField,
  phone: phoneField,
  abn: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim().length === 0 ? undefined : value,
    abnField.optional(),
  ),
  acn: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim().length === 0 ? undefined : value,
    z.string().trim().max(20).optional(),
  ),
  residence: z.string().trim().min(2).max(120),
  investorClassifications: z.array(investorClassificationSchema).min(1),
  capitalAllocation: capitalAllocationSchema,
  ecosystemFocus: ecosystemFocusSchema,
  strategicNotes: z.string().trim().min(10).max(4000),
  authorizedName: personNameField(2, 120),
  declarationAccepted: acceptedTrue,
  locale: localeField,
  source: z.string().trim().max(200).optional(),
  honeypot: honeypotField,
});

export type InvestorLeadInput = z.infer<typeof investorLeadSchema>;

export const createLeadResponseSchema = z.object({
  id: z.string().uuid(),
  type: leadTypeSchema,
  status: leadStatusSchema,
  createdAt: z.string().datetime(),
  warnings: z.array(z.string()).optional(),
  possibleDuplicate: z.boolean().optional(),
});

export type CreateLeadResponse = z.infer<typeof createLeadResponseSchema>;

export const otpRequestSchema = z.object({
  email: emailField.optional(),
  phone: z
    .string()
    .trim()
    .min(8)
    .max(32)
    .optional(),
  deviceLabel: z.string().trim().max(120).optional(),
}).refine((value) => Boolean(value.email || value.phone), {
  message: 'email or phone is required',
});

export type OtpRequestInput = z.infer<typeof otpRequestSchema>;

export const otpVerifySchema = z.object({
  email: emailField.optional(),
  phone: z.string().trim().min(8).max(32).optional(),
  code: z.string().trim().regex(/^\d{4,8}$/),
  deviceLabel: z.string().trim().max(120).optional(),
}).refine((value) => Boolean(value.email || value.phone), {
  message: 'email or phone is required',
});

export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

const principalScopeSchema = z.object({
  scopeType: z.enum(['STATE', 'LOCAL']),
  regionCode: z.string().nullable(),
  territoryCode: z.string().nullable(),
});

export const authPrincipalSchema = z.object({
  kind: z.enum(['admin', 'user']),
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: z.enum([
    AppRole.SUPER_ADMIN,
    AppRole.STATE_MASTER,
    AppRole.LOCAL_BDE,
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
  ]),
  scopes: z.array(principalScopeSchema).optional(),
});

export type AuthPrincipalDto = z.infer<typeof authPrincipalSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.string(),
  sessionId: z.string().uuid(),
  principal: authPrincipalSchema,
  /** Phase 0 admin UI compat — present when kind=admin */
  admin: z
    .object({
      id: z.string().uuid(),
      email: z.string().email(),
      name: z.string().nullable(),
      role: z.enum([
        AdminRole.SUPER_ADMIN,
        AdminRole.STATE_MASTER,
        AdminRole.LOCAL_BDE,
      ]),
    })
    .optional(),
});

export type AuthTokens = z.infer<typeof authTokensSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(20),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

export const logoutSchema = z.object({
  refreshToken: z.string().min(20).optional(),
  allDevices: z.boolean().optional().default(false),
});

export type LogoutInput = z.infer<typeof logoutSchema>;

/** Super invites State Master / Local BDE (replaces instant-active provision). */
export const inviteAdminSchema = z
  .object({
    email: emailField,
    name: z.string().trim().min(1).max(120).optional(),
    phone: phoneField.optional(),
    role: z.enum([AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE]),
    regionCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2,3}$/),
    territoryCode: z
      .string()
      .trim()
      .toUpperCase()
      .max(32)
      .optional(),
    leadId: z.string().uuid().optional(),
    companyName: z.string().trim().min(2).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.role === AdminRole.LOCAL_BDE && !value.territoryCode) {
      ctx.addIssue({
        code: 'custom',
        path: ['territoryCode'],
        message: 'territoryCode is required for LOCAL_BDE',
      });
    }
  });

export type InviteAdminInput = z.infer<typeof inviteAdminSchema>;

/** @deprecated Use inviteAdminSchema — kept as alias for API compatibility. */
export const provisionAdminSchema = inviteAdminSchema;
export type ProvisionAdminInput = InviteAdminInput;

export const resendAdminInviteSchema = z.object({
  email: emailField,
});
export type ResendAdminInviteInput = z.infer<typeof resendAdminInviteSchema>;

export const adminAcceptInviteSchema = z.object({
  token: z.string().trim().min(16).max(200),
});
export type AdminAcceptInviteInput = z.infer<typeof adminAcceptInviteSchema>;

export const partnerOnboardingUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: phoneField.optional(),
  companyName: z.string().trim().min(2).max(200).optional(),
  abn: abnField.optional(),
  acn: z.string().trim().max(20).optional(),
  corporateAddress: z.string().trim().min(5).max(500).optional(),
  networkExperience: z.string().trim().min(10).max(4000).optional(),
  executionStrategy: z.string().trim().min(10).max(4000).optional(),
});
export type PartnerOnboardingUpdateInput = z.infer<typeof partnerOnboardingUpdateSchema>;

export const partnerOnboardingSubmitSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(20),
  declarationAccuracy: z.literal(true),
  declarationNda: z.literal(true),
  declarationNonCompete: z.literal(true),
});
export type PartnerOnboardingSubmitInput = z.infer<typeof partnerOnboardingSubmitSchema>;

export const stepUpVerifySchema = z.object({
  code: z.string().trim().regex(/^\d{4,8}$/),
});

export type StepUpVerifyInput = z.infer<typeof stepUpVerifySchema>;

export const adminLeadListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  type: leadTypeSchema.optional(),
  status: leadStatusSchema.optional(),
  q: z.string().trim().max(200).optional(),
  priority: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (typeof value === 'boolean') return value;
      return value === 'true';
    }),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type AdminLeadListQuery = z.infer<typeof adminLeadListQuerySchema>;

export const updateLeadSchema = z
  .object({
    status: leadStatusSchema.optional(),
    priority: z.boolean().optional(),
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.priority !== undefined ||
      value.assigneeId !== undefined,
    { message: 'At least one field is required' },
  );

export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const createLeadNoteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

export type CreateLeadNoteInput = z.infer<typeof createLeadNoteSchema>;

export const adminAuditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  action: z.string().trim().max(100).optional(),
  leadId: z.string().uuid().optional(),
});

export type AdminAuditQuery = z.infer<typeof adminAuditQuerySchema>;

export const adminLeadExportQuerySchema = z.object({
  type: leadTypeSchema.optional(),
  status: leadStatusSchema.optional(),
  q: z.string().trim().max(200).optional(),
});

export type AdminLeadExportQuery = z.infer<typeof adminLeadExportQuerySchema>;

export const companyTypeSchema = z.enum(['SENDER', 'CARRIER']);
export type CompanyTypeFilter = z.infer<typeof companyTypeSchema>;

export const companyStatusSchema = z.enum([
  'DRAFT',
  'PENDING_VERIFICATION',
  'PENDING_REVIEW',
  'INFO_REQUESTED',
  'PENDING_PAYMENT',
  'PENDING_COMPLIANCE_DOCS',
  'PENDING_SETTLEMENT_SETUP',
  'PENDING_FLEET_READINESS',
  'ACTIVE',
  'BID_ELIGIBLE',
  'SUSPENDED',
  'REJECTED',
]);
export type CompanyStatusFilter = z.infer<typeof companyStatusSchema>;

export const adminCompanyListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  type: companyTypeSchema.optional(),
  status: companyStatusSchema.optional(),
  regionCode: z.string().trim().max(16).optional(),
  q: z.string().trim().max(200).optional(),
});

export type AdminCompanyListQuery = z.infer<typeof adminCompanyListQuerySchema>;

/** Super Admin soft-disable (suspend) company + cascade users/drivers/vehicles. */
export const disableCompanySchema = z.object({
  reason: z.string().trim().min(3).max(500),
  note: z.string().trim().max(2000).optional(),
});
export type DisableCompanyInput = z.infer<typeof disableCompanySchema>;

export const ComplianceDocType = {
  ABN_EXTRACT: 'ABN_EXTRACT',
  GOVERNMENT_ID: 'GOVERNMENT_ID',
  SELFIE: 'SELFIE',
  DRIVER_LICENCE: 'DRIVER_LICENCE',
  VEHICLE_REGO: 'VEHICLE_REGO',
  RWC: 'RWC',
  PUBLIC_LIABILITY: 'PUBLIC_LIABILITY',
  CARGO_INSURANCE: 'CARGO_INSURANCE',
  INSURANCE: 'INSURANCE',
  NHVR: 'NHVR',
  MASTER_ADMIN_AGREEMENT: 'MASTER_ADMIN_AGREEMENT',
  OTHER: 'OTHER',
} as const;

export type ComplianceDocType = (typeof ComplianceDocType)[keyof typeof ComplianceDocType];

export const createUploadIntentSchema = z.object({
  companyId: z.string().uuid(),
  docType: z.enum([
    ComplianceDocType.ABN_EXTRACT,
    ComplianceDocType.GOVERNMENT_ID,
    ComplianceDocType.SELFIE,
    ComplianceDocType.DRIVER_LICENCE,
    ComplianceDocType.VEHICLE_REGO,
    ComplianceDocType.RWC,
    ComplianceDocType.PUBLIC_LIABILITY,
    ComplianceDocType.CARGO_INSURANCE,
    ComplianceDocType.INSURANCE,
    ComplianceDocType.NHVR,
    ComplianceDocType.MASTER_ADMIN_AGREEMENT,
    ComplianceDocType.OTHER,
  ]),
  vehicleId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
  originalFilename: z.string().trim().min(1).max(255),
  mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  expiresAt: z.string().datetime().optional(),
});

export type CreateUploadIntentInput = z.infer<typeof createUploadIntentSchema>;

export const confirmDocumentSchema = z.object({
  contentHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/i, 'contentHash must be sha256 hex'),
});

export type ConfirmDocumentInput = z.infer<typeof confirmDocumentSchema>;

export const submitComplianceSchema = z.object({
  companyId: z.string().uuid(),
  caseType: z.enum(['SENDER_KYB', 'SENDER_KYC', 'CARRIER_KYB', 'ADMIN_PARTNER_KYB']),
  documentIds: z.array(z.string().uuid()).min(1).max(50),
});

export type SubmitComplianceInput = z.infer<typeof submitComplianceSchema>;

export const complianceCaseListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(['OPEN', 'INFO_REQUESTED', 'ESCALATED', 'APPROVED', 'REJECTED', 'CLOSED'])
    .optional(),
  caseType: z.enum(['SENDER_KYB', 'SENDER_KYC', 'CARRIER_KYB', 'ADMIN_PARTNER_KYB']).optional(),
  regionCode: z.string().trim().toUpperCase().max(3).optional(),
});

export type ComplianceCaseListQuery = z.infer<typeof complianceCaseListQuerySchema>;

export const complianceDecisionSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

export type ComplianceDecisionInput = z.infer<typeof complianceDecisionSchema>;

export const abrLookupQuerySchema = z.object({
  abn: z
    .string()
    .trim()
    .transform((value) => value.replace(/\s/g, ''))
    .refine((value) => /^\d{11}$/.test(value), 'ABN must be 11 digits'),
});

export type AbrLookupQuery = z.infer<typeof abrLookupQuerySchema>;

export const senderRegisterSchema = z.object({
  email: emailField,
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(8).max(32).optional(),
  acceptedTerms: acceptedTrue,
  /** Local BDE company invite token — invalid/expired → HQ (no referrer). */
  inviteToken: z.string().trim().min(16).max(200).optional(),
});

export type SenderRegisterInput = z.infer<typeof senderRegisterSchema>;

export const senderProfileSchema = z
  .object({
    accountType: z.enum(['BUSINESS', 'INDIVIDUAL']),
    legalName: z.string().trim().min(2).max(200),
    tradingName: z.string().trim().max(200).optional(),
    abn: z
      .string()
      .trim()
      .transform((v) => v.replace(/\s/g, ''))
      .refine((v) => v === '' || /^\d{11}$/.test(v), 'ABN must be 11 digits')
      .optional(),
    acn: z.string().trim().max(20).optional(),
    phone: z.string().trim().min(8).max(32).optional(),
    homeRegionCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/).default('VIC'),
    invoiceLegalName: z.string().trim().min(2).max(200),
    invoiceAddressLine1: z.string().trim().min(3).max(200),
    invoiceSuburb: z.string().trim().min(2).max(100),
    invoiceState: z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/),
    invoicePostcode: z.string().trim().regex(/^\d{4}$/),
    gstRegistered: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.accountType === 'BUSINESS' && !value.abn?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['abn'],
        message: 'ABN is required for business senders',
      });
    }
  });

export type SenderProfileInput = z.infer<typeof senderProfileSchema>;

export const senderSubmitVerificationSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(20),
});

export type SenderSubmitVerificationInput = z.infer<typeof senderSubmitVerificationSchema>;

export const senderPaymentConfirmSchema = z.object({
  /** Real Stripe PaymentMethod id, or omit in mock mode */
  paymentMethodId: z.string().trim().min(3).max(200).optional(),
});

export type SenderPaymentConfirmInput = z.infer<typeof senderPaymentConfirmSchema>;

export const carrierRegisterSchema = z.object({
  email: emailField,
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(8).max(32).optional(),
  acceptedTerms: acceptedTrue,
  /** Local BDE company invite token — invalid/expired → HQ (no referrer). */
  inviteToken: z.string().trim().min(16).max(200).optional(),
});

export type CarrierRegisterInput = z.infer<typeof carrierRegisterSchema>;

export const ProspectStage = {
  LEAD: 'LEAD',
  CONTACTED: 'CONTACTED',
  INVITED: 'INVITED',
  ONBOARDING: 'ONBOARDING',
  WON: 'WON',
  LOST: 'LOST',
} as const;
export type ProspectStage = (typeof ProspectStage)[keyof typeof ProspectStage];

export const createCompanyInviteSchema = z.object({
  companyType: z.enum(['SENDER', 'CARRIER']),
  email: emailField,
  legalNameHint: z.string().trim().min(2).max(200).optional(),
  prospectId: z.string().uuid().optional(),
});
export type CreateCompanyInviteInput = z.infer<typeof createCompanyInviteSchema>;

export const growthMyCompaniesQuerySchema = z.object({
  type: z.enum(['SENDER', 'CARRIER']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(120).optional(),
});
export type GrowthMyCompaniesQuery = z.infer<typeof growthMyCompaniesQuerySchema>;

export const createProspectSchema = z.object({
  companyType: z.enum(['SENDER', 'CARRIER']),
  legalName: z.string().trim().min(2).max(200),
  contactName: z.string().trim().min(1).max(120).optional(),
  email: emailField.optional(),
  phone: phoneField.optional(),
  notes: z.string().trim().max(4000).optional(),
  stage: z
    .enum(['LEAD', 'CONTACTED', 'INVITED', 'ONBOARDING', 'WON', 'LOST'])
    .optional()
    .default('LEAD'),
});
export type CreateProspectInput = z.infer<typeof createProspectSchema>;

export const updateProspectSchema = z.object({
  legalName: z.string().trim().min(2).max(200).optional(),
  contactName: z.string().trim().min(1).max(120).nullable().optional(),
  email: emailField.nullable().optional(),
  phone: phoneField.nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  stage: z.enum(['LEAD', 'CONTACTED', 'INVITED', 'ONBOARDING', 'WON', 'LOST']).optional(),
});
export type UpdateProspectInput = z.infer<typeof updateProspectSchema>;

export const prospectListQuerySchema = z.object({
  stage: z.enum(['LEAD', 'CONTACTED', 'INVITED', 'ONBOARDING', 'WON', 'LOST']).optional(),
  companyType: z.enum(['SENDER', 'CARRIER']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(120).optional(),
});
export type ProspectListQuery = z.infer<typeof prospectListQuerySchema>;

export const reassignCompanyReferrerSchema = z.object({
  /** Target ACTIVE Local BDE, or null to clear → HQ */
  adminUserId: z.string().uuid().nullable(),
});
export type ReassignCompanyReferrerInput = z.infer<typeof reassignCompanyReferrerSchema>;

export const carrierProfileSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradingName: z.string().trim().max(200).optional(),
  abn: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s/g, ''))
    .refine((v) => /^\d{11}$/.test(v), 'ABN must be 11 digits'),
  acn: z.string().trim().max(20).optional(),
  phone: z.string().trim().min(8).max(32).optional(),
  homeRegionCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/).default('VIC'),
});

export type CarrierProfileInput = z.infer<typeof carrierProfileSchema>;

export const carrierSubmitVerificationSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(20),
});

export type CarrierSubmitVerificationInput = z.infer<typeof carrierSubmitVerificationSchema>;

export const carrierVehicleSchema = z.object({
  label: z.string().trim().min(1).max(120),
  registration: z.string().trim().min(2).max(20),
  vehicleClass: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(UTE|VAN|RIGID_1_2T|RIGID_3_4T|SEMI|BDOUBLE)$/),
  tareKg: z.number().int().positive().max(100_000).optional(),
  gvmKg: z.number().int().positive().max(200_000).optional(),
  gcmKg: z.number().int().positive().max(300_000).optional(),
});

export type CarrierVehicleInput = z.infer<typeof carrierVehicleSchema>;

/** Carrier disable / retire vehicle or driver — reason shown in ops + audit. */
export const fleetDisableReasonSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  note: z.string().trim().max(2000).optional(),
});
export type FleetDisableReasonInput = z.infer<typeof fleetDisableReasonSchema>;

/** Carrier reassigns vehicle/driver on an active assignment (breakdown / continue). */
export const assignmentReassignSchema = z.object({
  vehicleId: z.string().uuid(),
  driverId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
  note: z.string().trim().max(2000).optional(),
});
export type AssignmentReassignInput = z.infer<typeof assignmentReassignSchema>;

export const TripExceptionKind = {
  DRIVER_UNAVAILABLE: 'DRIVER_UNAVAILABLE',
  VEHICLE_BREAKDOWN: 'VEHICLE_BREAKDOWN',
  ACCIDENT: 'ACCIDENT',
  TRAFFIC: 'TRAFFIC',
  OTHER: 'OTHER',
} as const;
export type TripExceptionKind = (typeof TripExceptionKind)[keyof typeof TripExceptionKind];

/** Driver opens sick-call / breakdown exception on a trip. */
export const tripExceptionOpenSchema = z
  .object({
    tripId: z.string().uuid(),
    kind: z.enum([
      'DRIVER_UNAVAILABLE',
      'VEHICLE_BREAKDOWN',
      'ACCIDENT',
      'TRAFFIC',
      'OTHER',
    ]),
    reasonCode: z.string().trim().min(2).max(80).optional(),
    note: z.string().trim().min(3).max(2000),
    gpsLat: z.number().min(-90).max(90).optional(),
    gpsLng: z.number().min(-180).max(180).optional(),
    photoDocumentId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'VEHICLE_BREAKDOWN' && !value.photoDocumentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Photo evidence is required for vehicle breakdown',
        path: ['photoDocumentId'],
      });
    }
  });
export type TripExceptionOpenInput = z.infer<typeof tripExceptionOpenSchema>;

/** Carrier resolves exception via intra-fleet reassign. */
export const tripExceptionReassignSchema = z.object({
  vehicleId: z.string().uuid(),
  driverId: z.string().uuid(),
  note: z.string().trim().max(2000).optional(),
});
export type TripExceptionReassignInput = z.infer<typeof tripExceptionReassignSchema>;

/** Carrier: repair & continue (no crew swap). */
export const tripExceptionContinueSchema = z.object({
  note: z.string().trim().min(3).max(2000),
  etaNote: z.string().trim().max(500).optional(),
});
export type TripExceptionContinueInput = z.infer<typeof tripExceptionContinueSchema>;

/** Carrier (or system): escalate to Ops — never silent. */
export const tripExceptionEscalateSchema = z.object({
  note: z.string().trim().min(3).max(2000).optional(),
});
export type TripExceptionEscalateInput = z.infer<typeof tripExceptionEscalateSchema>;

/** Carrier: explicit marketplace release / cancel path (never silent; M10 Stripe stub). */
export const tripExceptionReleaseSchema = z.object({
  note: z.string().trim().min(3).max(2000),
});
export type TripExceptionReleaseInput = z.infer<typeof tripExceptionReleaseSchema>;

export const carrierDriverInviteSchema = z.object({
  email: emailField,
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(8).max(32).optional(),
  licenceNo: z.string().trim().min(3).max(40).optional(),
});

export type CarrierDriverInviteInput = z.infer<typeof carrierDriverInviteSchema>;

export const carrierCapabilitiesSchema = z.object({
  capabilities: z
    .array(z.enum(['DG', 'REEFER', 'OVERSIZE', 'TAIL_LIFT', 'CURTAINSIDER', 'FLATBED', 'OTHER']))
    .default([]),
  serviceRegionCodes: z
    .array(z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/))
    .min(1)
    .max(8),
});

export type CarrierCapabilitiesInput = z.infer<typeof carrierCapabilitiesSchema>;

export const carrierBidStubSchema = z.object({
  jobId: z.string().uuid().optional(),
  amountAud: z.number().positive().max(1_000_000).optional(),
});

export type CarrierBidStubInput = z.infer<typeof carrierBidStubSchema>;

export const carrierDriverResendSchema = z.object({
  driverId: z.string().uuid(),
});

export type CarrierDriverResendInput = z.infer<typeof carrierDriverResendSchema>;

export const driverAcceptInviteSchema = z.object({
  token: z.string().trim().min(16).max(128),
});

export type DriverAcceptInviteInput = z.infer<typeof driverAcceptInviteSchema>;

export const driverProfileSchema = z.object({
  licenceNo: z.string().trim().min(3).max(40),
  licenceClass: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(C|LR|MR|HR|HC|MC)$/, 'Invalid licence class'),
  licenceExpiry: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  nhvrAcknowledged: z.literal(true),
  /** Optional DRIVER_LICENCE document id after upload */
  licenceDocumentId: z.string().uuid().optional(),
});

export type DriverProfileInput = z.infer<typeof driverProfileSchema>;

const vehicleClassField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^(UTE|VAN|RIGID_1_2T|RIGID_3_4T|SEMI|BDOUBLE)$/);

const jobStopSchema = z.object({
  sequence: z.number().int().min(0).max(3),
  stopType: z.enum(['PICKUP', 'DROPOFF', 'WAYPOINT']),
  label: z.string().trim().max(120).optional(),
  addressLine: z.string().trim().min(3).max(200),
  suburb: z.string().trim().min(2).max(80),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/),
  postcode: z.string().trim().min(4).max(8),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  receiverName: z.string().trim().min(2).max(120).optional(),
  receiverEmail: z.string().trim().email().optional(),
});

function refineJobStops(
  val: { pricingModel: 'PER_KM' | 'HOURLY'; stops: Array<{ stopType: string }> },
  ctx: z.RefinementCtx,
  options?: { requireHourlyPattern?: boolean; hourlyPattern?: 'A' | 'B' },
) {
  if (val.pricingModel === 'PER_KM' && val.stops.length !== 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Per-km jobs require exactly 1 pickup + 1 drop',
      path: ['stops'],
    });
  }
  if (options?.requireHourlyPattern && val.pricingModel === 'HOURLY' && !options.hourlyPattern) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Hourly jobs require Pattern A or B',
      path: ['hourlyPattern'],
    });
  }
  const pickups = val.stops.filter((s) => s.stopType === 'PICKUP').length;
  const drops = val.stops.filter((s) => s.stopType === 'DROPOFF').length;
  if (pickups < 1 || drops < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one PICKUP and one DROPOFF required',
      path: ['stops'],
    });
  }
}

export const jobCreateSchema = z
  .object({
    title: z.string().trim().min(2).max(160).optional(),
    pricingModel: z.enum(['PER_KM', 'HOURLY']),
    hourlyPattern: z.enum(['A', 'B']).optional(),
    pickupAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T/)),
    receiverName: z.string().trim().min(2).max(120),
    receiverEmail: z.string().trim().email(),
    receiverPhone: z.string().trim().min(8).max(32).optional(),
    deadWeightKg: z.number().positive().max(50_000),
    lengthCm: z.number().positive().max(2000),
    widthCm: z.number().positive().max(500),
    heightCm: z.number().positive().max(500),
    /** Sender-entered route distance; must be a real positive km (never null/0). */
    distanceKm: z.number().positive().max(20_000),
    loadTypes: z
      .array(z.enum(['GENERAL', 'DG', 'REEFER', 'OVERSIZE']))
      .min(1)
      .max(4)
      .default(['GENERAL']),
    /** Optional override; otherwise recommended from chargeable weight */
    minVehicleClass: vehicleClassField.optional(),
    siteManeuverability: z.enum(['EASY', 'MODERATE', 'TIGHT']),
    siteFacility: z.enum(['DOCK', 'GROUND', 'FORKLIFT', 'CRANE', 'OTHER']),
    siteDisclaimerAccepted: z.literal(true),
    stops: z.array(jobStopSchema).min(2).max(4),
  })
  .superRefine((val, ctx) => {
    refineJobStops(val, ctx, {
      requireHourlyPattern: true,
      hourlyPattern: val.hourlyPattern,
    });
  });

export type JobCreateInput = z.infer<typeof jobCreateSchema>;

/** Preview suggested distance/duration from pickup + drop (mock Valhalla today). */
export const jobRouteEstimateSchema = z
  .object({
    pricingModel: z.enum(['PER_KM', 'HOURLY']),
    stops: z.array(jobStopSchema).min(2).max(4),
  })
  .superRefine((val, ctx) => {
    refineJobStops(val, ctx);
  });

export type JobRouteEstimateInput = z.infer<typeof jobRouteEstimateSchema>;

export const proposalSubmitSchema = z.object({
  jobId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  driverId: z.string().uuid(),
  amountIncGstCents: z.number().int().positive().max(50_000_000),
  etaMinutes: z.number().int().positive().max(10_000),
});

export type ProposalSubmitInput = z.infer<typeof proposalSubmitSchema>;

export const tripSafetyCheckSchema = z.object({
  passed: z.boolean(),
  notes: z.string().trim().max(500).optional(),
  /** Client must be online — offline start/check rejected */
  online: z.literal(true),
});

export type TripSafetyCheckInput = z.infer<typeof tripSafetyCheckSchema>;

export const tripMassCheckSchema = z.object({
  actualMassKg: z.number().positive().max(100_000),
  online: z.literal(true),
});

export type TripMassCheckInput = z.infer<typeof tripMassCheckSchema>;

export const tripStartSchema = z.object({
  online: z.literal(true),
});

export type TripStartInput = z.infer<typeof tripStartSchema>;

export const tripBreakSchema = z.object({
  onBreak: z.boolean(),
});

export type TripBreakInput = z.infer<typeof tripBreakSchema>;

export const tripLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  recordedAt: z.string().datetime({ offset: true }).optional(),
});

export type TripLocationInput = z.infer<typeof tripLocationSchema>;

