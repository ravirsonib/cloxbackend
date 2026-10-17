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
  AUTH_OTP_REQUESTED: 'auth.otp_requested',
  AUTH_OTP_VERIFIED: 'auth.otp_verified',
  AUTH_OTP_FAILED: 'auth.otp_failed',
  AUTH_TOKEN_REFRESHED: 'auth.token_refreshed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_SESSION_REVOKED: 'auth.session_revoked',
  AUTH_STEP_UP_REQUESTED: 'auth.step_up_requested',
  AUTH_STEP_UP_VERIFIED: 'auth.step_up_verified',
  ADMIN_PROVISIONED: 'admin.provisioned',
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
  CARRIER_DRIVER_INVITED: 'carrier.driver_invited',
  CARRIER_DRIVER_INVITE_RESENT: 'carrier.driver_invite_resent',
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
  companyLegalName: z.string().trim().min(2).max(200),
  abn: abnField,
  shippingOrigin: z.string().trim().min(2).max(120),
  operationalModels: z.array(z.string().min(1)).min(1),
  biddingType: z.array(z.string().min(1)).min(1),
  monthlyVolume: z.string().trim().min(1),
  infraAcknowledged: z.array(z.string()).default([]),
  email: emailField,
  phone: z.string().trim().min(8).max(30),
  locale: localeField,
  source: z.string().trim().max(200).optional(),
  honeypot: honeypotField,
});

export const registryCarrierSchema = z.object({
  userType: z.literal('carrier'),
  fleetEntityName: z.string().trim().min(2).max(200),
  abn: abnField,
  depotState: z.string().trim().min(2).max(80),
  fleetComposition: z.array(z.string().min(1)).min(1),
  capabilities: z.array(z.string()).default([]),
  complianceAuthorized: acceptedTrue,
  infraAcknowledged: z.array(z.string()).default([]),
  email: emailField,
  phone: z.string().trim().min(8).max(30),
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
  fullLegalName: z.string().trim().min(2).max(120),
  companyName: z.string().trim().min(2).max(200),
  abn: abnField,
  acn: z.string().trim().max(20).optional(),
  email: emailField,
  phone: z.string().trim().min(8).max(30),
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
  fullNameOrEntity: z.string().trim().min(2).max(200),
  contactPersonName: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim().length === 0 ? undefined : value,
    z.string().trim().max(120).optional(),
  ),
  email: emailField,
  phone: z.string().trim().min(8).max(30),
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
  authorizedName: z.string().trim().min(2).max(120),
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
  email: emailField,
});

export type OtpRequestInput = z.infer<typeof otpRequestSchema>;

export const otpVerifySchema = z.object({
  email: emailField,
  code: z.string().trim().regex(/^\d{4,8}$/),
});

export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.string(),
  sessionId: z.string().uuid().optional(),
  principal: z
    .object({
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
      scopes: z
        .array(
          z.object({
            scopeType: z.enum(['STATE', 'LOCAL']),
            regionCode: z.string().nullable(),
            territoryCode: z.string().nullable(),
          }),
        )
        .optional(),
    })
    .optional(),
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
