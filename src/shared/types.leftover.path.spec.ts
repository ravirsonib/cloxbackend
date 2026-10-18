import {
  abrLookupQuerySchema,
  adminLeadListQuerySchema,
  carrierProfileSchema,
  investorLeadSchema,
  jobCreateSchema,
  senderProfileSchema,
  updateLeadSchema,
} from './types';

const uuid = '11111111-1111-4111-8111-111111111111';

describe('shared/types leftover schema paths', () => {
  it('phoneField rejects digit strings that are not AU numbers', () => {
    const result = investorLeadSchema.safeParse({
      fullNameOrEntity: 'Fund Co',
      email: 'invest@yopmail.com',
      phone: '12345678', // digits but not 0… or 61…
      residence: 'Melbourne',
      investorClassifications: ['sophisticated_investor'],
      capitalAllocation: '25000_99999',
      ecosystemFocus: 'pure_financial_growth',
      strategicNotes: 'Looking to allocate capital into CLOX network.',
      authorizedName: 'Jane Doe',
      declarationAccepted: true,
    });
    expect(result.success).toBe(false);
  });

  it('investorLeadSchema preprocess clears empty contact/abn/acn strings', () => {
    const result = investorLeadSchema.safeParse({
      fullNameOrEntity: 'Fund Co Pty',
      contactPersonName: '   ',
      email: 'Invest.Clox@yopmail.com',
      phone: '+61412345678',
      abn: '  ',
      acn: '',
      residence: 'Sydney',
      investorClassifications: ['professional_investor'],
      capitalAllocation: '100000_249999',
      ecosystemFocus: 'strategic_carrier_fleet',
      strategicNotes: 'Strategic notes for coverage leftover path.',
      authorizedName: 'Alex Smith',
      declarationAccepted: 'true',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contactPersonName).toBeUndefined();
      expect(result.data.abn).toBeUndefined();
      expect(result.data.acn).toBeUndefined();
      expect(result.data.email).toBe('invest.clox@yopmail.com');
    }
  });

  it('adminLeadListQuerySchema transforms priority string and boolean', () => {
    expect(
      adminLeadListQuerySchema.parse({ priority: 'true' }).priority,
    ).toBe(true);
    expect(
      adminLeadListQuerySchema.parse({ priority: 'false' }).priority,
    ).toBe(false);
    expect(
      adminLeadListQuerySchema.parse({ priority: true }).priority,
    ).toBe(true);
    expect(
      adminLeadListQuerySchema.parse({}).priority,
    ).toBeUndefined();
  });

  it('updateLeadSchema rejects empty patch', () => {
    expect(updateLeadSchema.safeParse({}).success).toBe(false);
    expect(
      updateLeadSchema.safeParse({ priority: true }).success,
    ).toBe(true);
  });

  it('abrLookupQuerySchema strips spaces and validates 11 digits', () => {
    expect(abrLookupQuerySchema.parse({ abn: '51 824 753 556' })).toEqual({
      abn: '51824753556',
    });
    expect(abrLookupQuerySchema.safeParse({ abn: '123' }).success).toBe(false);
  });

  it('senderProfileSchema ABN transform/refine + BUSINESS requires ABN', () => {
    expect(
      senderProfileSchema.safeParse({
        accountType: 'INDIVIDUAL',
        legalName: 'Sam Sender',
        abn: '51 824 753 556',
        invoiceLegalName: 'Sam Sender',
        invoiceAddressLine1: '1 St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
      }).success,
    ).toBe(true);

    expect(
      senderProfileSchema.safeParse({
        accountType: 'INDIVIDUAL',
        legalName: 'Sam Sender',
        abn: '123',
        invoiceLegalName: 'Sam Sender',
        invoiceAddressLine1: '1 St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
      }).success,
    ).toBe(false);

    expect(
      senderProfileSchema.safeParse({
        accountType: 'BUSINESS',
        legalName: 'Biz Co',
        invoiceLegalName: 'Biz Co',
        invoiceAddressLine1: '1 St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
      }).success,
    ).toBe(false);
  });

  it('carrierProfileSchema ABN transform and refine', () => {
    expect(
      carrierProfileSchema.parse({
        legalName: 'Carrier Co',
        abn: '51 824 753 556',
      }).abn,
    ).toBe('51824753556');
    expect(
      carrierProfileSchema.safeParse({
        legalName: 'Carrier Co',
        abn: 'not-an-abn',
      }).success,
    ).toBe(false);
  });

  it('jobCreateSchema superRefine enforces per-km/hourly/pickup-drop rules', () => {
    const baseStop = (seq: number, type: 'PICKUP' | 'DROPOFF') => ({
      sequence: seq,
      stopType: type,
      addressLine: `${seq} Street`,
      suburb: 'Melbourne',
      state: 'VIC',
      postcode: '3000',
      lat: -37.8,
      lng: 144.9,
    });

    // PER_KM with 3 stops
    expect(
      jobCreateSchema.safeParse({
        pricingModel: 'PER_KM',
        pickupAt: '2026-10-10T10:00:00+11:00',
        receiverName: 'Recv',
        receiverEmail: 'recv@yopmail.com',
        deadWeightKg: 100,
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        distanceKm: 12,
        siteManeuverability: 'EASY',
        siteFacility: 'DOCK',
        siteDisclaimerAccepted: true,
        stops: [
          baseStop(0, 'PICKUP'),
          baseStop(1, 'DROPOFF'),
          baseStop(2, 'DROPOFF'),
        ],
      }).success,
    ).toBe(false);

    // HOURLY missing pattern
    expect(
      jobCreateSchema.safeParse({
        pricingModel: 'HOURLY',
        pickupAt: '2026-10-10T10:00:00+11:00',
        receiverName: 'Recv',
        receiverEmail: 'recv@yopmail.com',
        deadWeightKg: 100,
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        distanceKm: 12,
        siteManeuverability: 'EASY',
        siteFacility: 'DOCK',
        siteDisclaimerAccepted: true,
        stops: [baseStop(0, 'PICKUP'), baseStop(1, 'DROPOFF')],
      }).success,
    ).toBe(false);

    // no pickup
    expect(
      jobCreateSchema.safeParse({
        pricingModel: 'PER_KM',
        pickupAt: '2026-10-10T10:00:00+11:00',
        receiverName: 'Recv',
        receiverEmail: 'recv@yopmail.com',
        deadWeightKg: 100,
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        distanceKm: 12,
        siteManeuverability: 'EASY',
        siteFacility: 'DOCK',
        siteDisclaimerAccepted: true,
        stops: [
          { ...baseStop(0, 'DROPOFF'), stopType: 'WAYPOINT' as const },
          baseStop(1, 'DROPOFF'),
        ],
      }).success,
    ).toBe(false);

    // valid hourly
    expect(
      jobCreateSchema.safeParse({
        pricingModel: 'HOURLY',
        hourlyPattern: 'A',
        pickupAt: '2026-10-10T10:00:00+11:00',
        receiverName: 'Recv',
        receiverEmail: 'recv@yopmail.com',
        deadWeightKg: 100,
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        distanceKm: 12,
        siteManeuverability: 'EASY',
        siteFacility: 'DOCK',
        siteDisclaimerAccepted: true,
        stops: [baseStop(0, 'PICKUP'), baseStop(1, 'DROPOFF')],
        vehicleId: uuid,
      }).success,
    ).toBe(true);
  });
});
