import { CompanyStatus } from '@prisma/client';
import { SenderService } from './sender.service';

function makeService(company: Record<string, unknown>) {
  const prisma = {
    isConnected: () => true,
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 's@yopmail.com',
        name: 'S',
        phone: null,
        role: 'SENDER',
        company: {
          id: 'c1',
          type: 'SENDER',
          homeRegion: { code: 'VIC' },
          complianceCases: [],
          legalName: 'Co',
          tradingName: null,
          abn: '51824753556',
          acn: null,
          gstRegistered: true,
          stripeCustomerId: null,
          homeRegionId: null,
          senderAccountType: 'BUSINESS',
          ...company,
        },
      }),
    },
  };
  return new SenderService(
    prisma as never,
    { recordPlatform: jest.fn() } as never,
    { isMockMode: () => true } as never,
    { get: () => undefined } as never,
  );
}

const principal = {
  id: 'u1',
  email: 's@yopmail.com',
  role: 'SENDER' as const,
  kind: 'user' as const,
  regionCodes: [],
  territoryCodes: [],
};

describe('SenderService go/no-go matrix (M3-31)', () => {
  it.each([
    {
      name: 'DRAFT incomplete',
      company: {
        status: CompanyStatus.DRAFT,
        paymentReady: false,
        invoiceLegalName: null,
        invoiceAddressLine1: null,
        invoiceSuburb: null,
        invoiceState: null,
        invoicePostcode: null,
      },
      canBook: false,
    },
    {
      name: 'PENDING_PAYMENT with invoice',
      company: {
        status: CompanyStatus.PENDING_PAYMENT,
        paymentReady: false,
        invoiceLegalName: 'Co',
        invoiceAddressLine1: '1 St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
      },
      canBook: false,
    },
    {
      name: 'ACTIVE missing invoice',
      company: {
        status: CompanyStatus.ACTIVE,
        paymentReady: true,
        invoiceLegalName: null,
        invoiceAddressLine1: null,
        invoiceSuburb: null,
        invoiceState: null,
        invoicePostcode: null,
      },
      canBook: false,
    },
    {
      name: 'ACTIVE complete',
      company: {
        status: CompanyStatus.ACTIVE,
        paymentReady: true,
        invoiceLegalName: 'Co',
        invoiceAddressLine1: '1 St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
      },
      canBook: true,
    },
  ])('$name → canBook=$canBook', async ({ company, canBook }) => {
    const service = makeService(company);
    const result = await service.getBookingEligibility(principal);
    expect(result.canBook).toBe(canBook);
  });
});
