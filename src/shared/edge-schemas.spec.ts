import {
  otpRequestSchema,
  otpVerifySchema,
  senderProfileSchema,
  senderRegisterSchema,
  createUploadIntentSchema,
  registryLeadSchema,
} from './types';

describe('Zod schemas — M1/M2/M3 edge validation', () => {
  describe('OTP (M1-2, M1-13)', () => {
    it('rejects empty otp request', () => {
      const r = otpRequestSchema.safeParse({});
      expect(r.success).toBe(false);
    });

    it('accepts email-only request', () => {
      expect(otpRequestSchema.safeParse({ email: 'clox.mail@yopmail.com' }).success).toBe(true);
    });

    it('rejects non-digit OTP code', () => {
      expect(otpVerifySchema.safeParse({ email: 'clox.mail@yopmail.com', code: 'abc' }).success).toBe(false);
    });

    it('accepts 6-digit code', () => {
      expect(otpVerifySchema.safeParse({ email: 'clox.mail@yopmail.com', code: '123456' }).success).toBe(true);
    });
  });

  describe('Sender register/profile (M3-2, M3-9)', () => {
    it('requires acceptedTerms true', () => {
      expect(
        senderRegisterSchema.safeParse({
          name: 'Test',
          email: 't@clox.test',
          acceptedTerms: false,
        }).success,
      ).toBe(false);
    });

    it('requires ABN for BUSINESS', () => {
      const r = senderProfileSchema.safeParse({
        accountType: 'BUSINESS',
        legalName: 'Co',
        homeRegionCode: 'VIC',
        invoiceLegalName: 'Co',
        invoiceAddressLine1: '1 St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
      });
      expect(r.success).toBe(false);
    });

    it('accepts INDIVIDUAL without ABN', () => {
      const r = senderProfileSchema.safeParse({
        accountType: 'INDIVIDUAL',
        legalName: 'Person',
        homeRegionCode: 'VIC',
        invoiceLegalName: 'Person',
        invoiceAddressLine1: '1 St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
      });
      expect(r.success).toBe(true);
    });
  });

  describe('Upload intent (M2-1)', () => {
    it('rejects image/gif mime', () => {
      const r = createUploadIntentSchema.safeParse({
        companyId: '00000000-0000-4000-8000-000000000001',
        docType: 'ABN_EXTRACT',
        originalFilename: 'x.gif',
        mimeType: 'image/gif',
        sizeBytes: 100,
      });
      expect(r.success).toBe(false);
    });

    it('rejects size over 10MB', () => {
      const r = createUploadIntentSchema.safeParse({
        companyId: '00000000-0000-4000-8000-000000000001',
        docType: 'ABN_EXTRACT',
        originalFilename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 11 * 1024 * 1024,
      });
      expect(r.success).toBe(false);
    });
  });
});

describe('Registry lead schema — QA regression', () => {
  const validSender = {
    userType: 'sender' as const,
    companyLegalName: 'Acme Manufacturing Pty Ltd',
    abn: '51824753556',
    shippingOrigin: 'Melbourne',
    operationalModels: ['Interstate Linehaul Lanes'],
    biddingType: ['Per-KM Dynamic Spot Market Bidding'],
    monthlyVolume: '$10k - $50k',
    infraAcknowledged: ['easyAML'],
    email: 'ops@acme.example',
    phone: '0412345678',
    locale: 'en' as const,
  };

  it('accepts a valid sender registry payload', () => {
    expect(registryLeadSchema.safeParse(validSender).success).toBe(true);
  });

  it('rejects company legal name that is only symbols', () => {
    const r = registryLeadSchema.safeParse({
      ...validSender,
      companyLegalName: '!@#$%^&*()_+',
    });
    expect(r.success).toBe(false);
  });

  it('rejects phone numbers containing letters', () => {
    const r = registryLeadSchema.safeParse({
      ...validSender,
      phone: '+044800894tr',
    });
    expect(r.success).toBe(false);
  });

  it('accepts formatted AU mobile numbers', () => {
    expect(
      registryLeadSchema.safeParse({ ...validSender, phone: '+61 412 345 678' })
        .success,
    ).toBe(true);
    expect(
      registryLeadSchema.safeParse({ ...validSender, phone: '04 1234 5678' }).success,
    ).toBe(true);
  });

  it('rejects fleet entity names with junk symbols', () => {
    const r = registryLeadSchema.safeParse({
      userType: 'carrier',
      fleetEntityName: '!!!@@@',
      abn: '51824753556',
      depotState: 'VIC',
      fleetComposition: ['Light Commercial / Courier Vans'],
      capabilities: [],
      complianceAuthorized: true,
      infraAcknowledged: ['easyAML'],
      email: 'fleet@acme.example',
      phone: '0412345678',
      locale: 'en',
    });
    expect(r.success).toBe(false);
  });
});
