import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { TripsService } from './trips.service';

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const carrier: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const stranger: AuthenticatedPrincipal = {
  id: 'user-other',
  email: 'other@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('TripsService getTripDocument ACL', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { createSurcharge: jest.fn() };
  let storageDir: string;
  let config: { get: (key: string) => unknown };

  function tripRow(overrides?: {
    senderCompanyId?: string;
    carrierCompanyId?: string;
    podStorageKey?: string | null;
  }) {
    const tripId = 'trip-1';
    return {
      id: tripId,
      jobId: 'job-abcdef01',
      status: 'COMPLETED',
      podStorageKey:
        overrides?.podStorageKey === undefined
          ? `trips/${tripId}/pod.pdf`
          : overrides.podStorageKey,
      taxInvoiceStorageKey: `trips/${tripId}/invoice.pdf`,
      runSheetStorageKey: `trips/${tripId}/run-sheet.pdf`,
      job: {
        senderCompanyId: overrides?.senderCompanyId ?? 'co-s',
        senderCompany: { id: overrides?.senderCompanyId ?? 'co-s' },
        stops: [
          {
            id: 'stop-drop',
            sequence: 2,
            stopType: 'DROPOFF',
            suburb: 'Richmond',
          },
        ],
      },
      stopProgress: [
        {
          jobStopId: 'stop-drop',
          podStatus: 'FINALIZED',
          signedAt: new Date(),
          signerName: 'Recv',
          podFinalizedAt: new Date(),
          podPackageStorageKey: `trips/${tripId}/stops/stop-drop/pod-package.pdf`,
          signaturePdfStorageKey: `trips/${tripId}/stops/stop-drop/signature.pdf`,
          goodsPhotoRefs: [],
        },
      ],
      assignment: {
        carrierCompanyId: overrides?.carrierCompanyId ?? 'co-c',
        driverId: 'drv-1',
        driver: { userId: 'user-driver' },
      },
    };
  }

  function makeService(prisma: Record<string, unknown>) {
    return new TripsService(
      prisma as never,
      audit as never,
      config as never,
      payments as never,
      {
        notifyTripApproaching: jest.fn(),
        notifyTripAtDropoff: jest.fn(),
        notifyPodFinalized: jest.fn(),
      } as never,
    );
  }

  beforeEach(async () => {
    storageDir = join(tmpdir(), `clox-doc-acl-${Date.now()}`);
    await mkdir(join(storageDir, 'trips', 'trip-1', 'stops', 'stop-drop'), {
      recursive: true,
    });
    await writeFile(join(storageDir, 'trips', 'trip-1', 'pod.pdf'), '%PDF-pod');
    await writeFile(join(storageDir, 'trips', 'trip-1', 'invoice.pdf'), '%PDF-inv');
    await writeFile(join(storageDir, 'trips', 'trip-1', 'run-sheet.pdf'), '%PDF-rs');
    await writeFile(
      join(storageDir, 'trips', 'trip-1', 'stops', 'stop-drop', 'pod-package.pdf'),
      '%PDF-pkg',
    );
    await writeFile(
      join(storageDir, 'trips', 'trip-1', 'stops', 'stop-drop', 'signature.pdf'),
      '%PDF-sig',
    );
    config = {
      get: (key: string) => {
        if (key === 'STORAGE_LOCAL_DIR') return storageDir;
        return 300;
      },
    };
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('sender downloads tax invoice when company matches', async () => {
    const prisma = {
      isConnected: () => true,
      trip: { findUnique: jest.fn().mockResolvedValue(tripRow()) },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
    };
    const file = await makeService(prisma).getTripDocument(sender, 'trip-1', 'tax-invoice');
    expect(file.mimeType).toBe('application/pdf');
    expect(file.filename).toContain('tax-invoice');
    file.stream.destroy();
  });

  it('carrier downloads run sheet when assignment matches', async () => {
    const prisma = {
      isConnected: () => true,
      trip: { findUnique: jest.fn().mockResolvedValue(tripRow()) },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', companyId: 'co-c' }),
      },
    };
    const file = await makeService(prisma).getTripDocument(carrier, 'trip-1', 'run-sheet');
    expect(file.filename).toContain('run-sheet');
    file.stream.destroy();
  });

  it('rejects sender from another company', async () => {
    const prisma = {
      isConnected: () => true,
      trip: { findUnique: jest.fn().mockResolvedValue(tripRow()) },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-other', companyId: 'co-x' }),
      },
    };
    await expect(
      makeService(prisma).getTripDocument(stranger, 'trip-1', 'pod'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404 when document key missing', async () => {
    const prisma = {
      isConnected: () => true,
      trip: {
        findUnique: jest.fn().mockResolvedValue(tripRow({ podStorageKey: null })),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
    };
    await expect(
      makeService(prisma).getTripDocument(sender, 'trip-1', 'pod'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getTripPod includes download paths', async () => {
    const prisma = {
      isConnected: () => true,
      trip: { findUnique: jest.fn().mockResolvedValue(tripRow()) },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
    };
    const pod = await makeService(prisma).getTripPod(sender, 'trip-1');
    expect(pod.downloads.pod).toBe('trips/trip-1/documents/pod');
    expect(pod.downloads.taxInvoice).toBe('trips/trip-1/documents/tax-invoice');
    expect(pod.dropoffs[0].downloads.podPackage).toContain('pod-package');
  });

  it('downloads stop pod-package PDF', async () => {
    const prisma = {
      isConnected: () => true,
      trip: { findUnique: jest.fn().mockResolvedValue(tripRow()) },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
    };
    const file = await makeService(prisma).getTripDocument(
      sender,
      'trip-1',
      'pod-package',
      'stop-drop',
    );
    expect(file.filename).toContain('pod-package');
    file.stream.destroy();
  });
});
