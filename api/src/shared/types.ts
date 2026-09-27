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
} as const;

export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

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
  biddingType: z.string().trim().min(1),
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
  admin: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string().nullable(),
    role: z.literal(AdminRole.SUPER_ADMIN),
  }),
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
