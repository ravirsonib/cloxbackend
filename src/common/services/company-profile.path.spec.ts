import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
} from '@prisma/client';
import { CompanyProfileService } from './company-profile.service';
import type { AuthenticatedPrincipal } from '../guards/jwt-auth.guard';

describe('CompanyProfileService', () => {
  const carrierPrincipal: AuthenticatedPrincipal = {
    id: 'user-c',
    email: 'carrier@yopmail.com',
    role: 'TRANSPORT_COMPANY',
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  const senderPrincipal: AuthenticatedPrincipal = {
    id: 'user-s',
    email: 'sender@yopmail.com',
    role: 'SENDER',
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  function carrierCompany(overrides: Record<string, unknown> = {}) {
    return {
      id: 'co-c',
      type: CompanyType.CARRIER,
      status: CompanyStatus.BID_ELIGIBLE,
      legalName: 'Haul Co',
      tradingName: 'Haul',
      abn: '51824753556',
      acn: null,
      email: 'carrier@yopmail.com',
      phone: '0400000001',
      homeRegionId: 'reg-vic',
      homeRegion: { code: 'VIC', name: 'Victoria' },
      serviceRegionCodes: ['VIC'],
      capabilities: [],
      senderAccountType: null,
      invoiceLegalName: null,
      invoiceAddressLine1: null,
      invoiceSuburb: null,
      invoiceState: null,
      invoicePostcode: null,
      gstRegistered: false,
      ...overrides,
    };
  }

  function makeService(prisma: Record<string, unknown>, audit = { recordPlatform: jest.fn() }) {
    return new CompanyProfileService(prisma as never, audit as never);
  }

  it('updateSelf patches trading name and phone for bid-eligible carrier', async () => {
    const company = carrierCompany();
    const updated = { ...company, tradingName: 'New Trade', phone: '0411111111' };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'user-c', company })
          .mockResolvedValueOnce({ id: 'user-c', company: updated }),
        update: jest.fn().mockResolvedValue({}),
      },
      company: { update: jest.fn().mockResolvedValue({}) },
      complianceCase: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    const result = await makeService(prisma).updateSelf(carrierPrincipal, {
      tradingName: 'New Trade',
      phone: '0411111111',
    });

    expect(prisma.company.update).toHaveBeenCalledWith({
      where: { id: 'co-c' },
      data: { tradingName: 'New Trade', phone: '0411111111' },
    });
    expect(result.company.tradingName).toBe('New Trade');
    expect(result.company.phone).toBe('0411111111');
  });

  it('updateSelf rejects draft carrier', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-c',
          company: carrierCompany({ status: CompanyStatus.DRAFT }),
        }),
      },
    };
    await expect(
      makeService(prisma).updateSelf(carrierPrincipal, { phone: '0411111111' }),
    ).rejects.toThrow(/bid-eligible/i);
  });

  it('requestChange opens COMPANY_PROFILE_CHANGE without mutating company', async () => {
    const company = carrierCompany();
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'user-c', company })
          .mockResolvedValueOnce({ id: 'user-c', company }),
      },
      complianceCase: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: 'case-p',
            status: ComplianceCaseStatus.OPEN,
            proposedChanges: { legalName: 'Haul Co Pty' },
            decisionNote: 'rename',
            createdAt: new Date('2026-10-22T00:00:00Z'),
          }),
        create: jest.fn().mockResolvedValue({ id: 'case-p' }),
      },
      company: { update: jest.fn() },
    };

    const result = await makeService(prisma).requestChange(carrierPrincipal, {
      legalName: 'Haul Co Pty',
      note: 'rename',
    });

    expect(prisma.complianceCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'co-c',
        caseType: ComplianceCaseType.COMPANY_PROFILE_CHANGE,
        proposedChanges: { legalName: 'Haul Co Pty' },
        decisionNote: 'rename',
      }),
    });
    expect(prisma.company.update).not.toHaveBeenCalled();
    expect(result.pendingChange?.id).toBe('case-p');
  });

  it('requestChange rejects when a profile case is already open', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-c',
          company: carrierCompany(),
        }),
      },
      complianceCase: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'case-open',
          status: ComplianceCaseStatus.OPEN,
          proposedChanges: { abn: '11111111111' },
          decisionNote: null,
          createdAt: new Date(),
        }),
      },
    };
    await expect(
      makeService(prisma).requestChange(carrierPrincipal, { abn: '11111111111' }),
    ).rejects.toThrow(/already pending/i);
  });

  it('applyProposedChanges updates company fields via transaction client', async () => {
    const tx = {
      region: { findUnique: jest.fn().mockResolvedValue({ id: 'reg-nsw', code: 'NSW' }) },
      company: { update: jest.fn().mockResolvedValue({}) },
    };
    const service = makeService({ isConnected: () => true });
    const applied = await service.applyProposedChanges(tx as never, 'co-c', {
      legalName: 'New Legal',
      homeRegionCode: 'NSW',
    });
    expect(applied).toEqual({ legalName: 'New Legal', homeRegionCode: 'NSW' });
    expect(tx.company.update).toHaveBeenCalledWith({
      where: { id: 'co-c' },
      data: {
        legalName: 'New Legal',
        homeRegion: { connect: { id: 'reg-nsw' } },
      },
    });
  });

  it('sender requestChange can include invoice fields', async () => {
    const company = carrierCompany({
      id: 'co-s',
      type: CompanyType.SENDER,
      status: CompanyStatus.ACTIVE,
      invoiceLegalName: 'Old Inv',
      invoiceAddressLine1: '1 St',
      invoiceSuburb: 'Melbourne',
      invoiceState: 'VIC',
      invoicePostcode: '3000',
      gstRegistered: false,
    });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'user-s', company })
          .mockResolvedValueOnce({ id: 'user-s', company }),
      },
      complianceCase: {
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
        create: jest.fn().mockResolvedValue({ id: 'case-s' }),
      },
      company: { update: jest.fn() },
    };
    await makeService(prisma).requestChange(senderPrincipal, {
      invoiceLegalName: 'New Inv',
      gstRegistered: true,
    });
    expect(prisma.complianceCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        proposedChanges: { invoiceLegalName: 'New Inv', gstRegistered: true },
      }),
    });
  });
});
