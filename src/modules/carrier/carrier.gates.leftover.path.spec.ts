import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CompanyStatus, CompanyType } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { CarrierService } from './carrier.service';

const carrier: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

function carrierCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'co-c',
    type: CompanyType.CARRIER,
    status: CompanyStatus.ACTIVE,
    legalName: 'Carrier',
    homeRegion: { code: 'VIC' },
    vehicles: [],
    drivers: [],
    complianceCases: [],
    complianceDocuments: [],
    ...overrides,
  };
}

describe('CarrierService gate leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = { isMockMode: jest.fn().mockReturnValue(true) };
  const config = { get: jest.fn() };
  const drivers = {};

  function makeService(prisma: Record<string, unknown>) {
    return new CarrierService(
      prisma as never,
      audit as never,
      stripe as never,
      config as never,
      drivers as never,
    );
  }

  it('ensureDatabase throws when offline', async () => {
    await expect(
      makeService({ isConnected: () => false }).getOnboarding(carrier),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requireCarrier 404 when company missing', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', company: null }) },
    };
    await expect(makeService(prisma).getOnboarding(carrier)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updateProfile rejects when not draft/info-requested', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.ACTIVE }),
        }),
      },
    };
    await expect(
      makeService(prisma).updateProfile(carrier, {
        legalName: 'X',
        homeRegionCode: 'VIC',
        abn: '51824753556',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateCapabilities rejects when not draft/info-requested', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.BID_ELIGIBLE }),
        }),
      },
    };
    await expect(
      makeService(prisma).updateCapabilities(carrier, {
        capabilities: ['DG'],
        serviceRegionCodes: ['VIC'],
      } as never),
    ).rejects.toThrow('Capabilities editable only in draft or info-requested');
  });
});
