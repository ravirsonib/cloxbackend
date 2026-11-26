import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { RealtimeGateway } from './realtime.gateway';

function makeSocket(principal: { id: string; role: string; companyId?: string }): Socket {
  return {
    id: 'sock-1',
    join: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
    principal,
  } as unknown as Socket;
}

describe('RealtimeGateway ACL', () => {
  const jwt = { verifyAsync: jest.fn() };
  const config = { get: jest.fn() };

  function makeGateway(prisma: Record<string, unknown>) {
    return new RealtimeGateway(jwt as never, config as never, prisma as never);
  }

  it('allows sender of the job to subscribe to trip', async () => {
    const prisma = {
      isConnected: () => true,
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'trip-1',
          job: { senderCompanyId: 'comp-sender' },
          assignment: { carrierCompanyId: 'comp-carrier', driverId: 'drv-1' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          companyId: 'comp-sender',
          driver: null,
        }),
      },
    };
    const gw = makeGateway(prisma);
    const sock = makeSocket({ id: 'u-1', role: 'SENDER' });
    const res = await gw.onSubscribeTrip(sock, { tripId: 'trip-1' });
    expect(res).toEqual({ subscribed: 'trip:trip-1' });
    expect(sock.join).toHaveBeenCalledWith('trip:trip-1');
  });

  it('rejects unrelated sender subscribing to another company trip', async () => {
    const prisma = {
      isConnected: () => true,
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'trip-1',
          job: { senderCompanyId: 'comp-sender-A' },
          assignment: { carrierCompanyId: 'comp-carrier', driverId: 'drv-1' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          companyId: 'comp-sender-B',
          driver: null,
        }),
      },
    };
    const gw = makeGateway(prisma);
    const sock = makeSocket({ id: 'u-2', role: 'SENDER' });
    await expect(gw.onSubscribeTrip(sock, { tripId: 'trip-1' })).rejects.toBeInstanceOf(
      WsException,
    );
    expect(sock.join).not.toHaveBeenCalled();
  });

  it('allows assigned driver to subscribe to trip and rejects other drivers', async () => {
    const prisma = {
      isConnected: () => true,
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'trip-1',
          job: { senderCompanyId: 'comp-sender' },
          assignment: { carrierCompanyId: 'comp-carrier', driverId: 'drv-1' },
        }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ companyId: 'comp-carrier', driver: { id: 'drv-1' } })
          .mockResolvedValueOnce({ companyId: 'comp-carrier', driver: { id: 'drv-2' } }),
      },
    };
    const gw = makeGateway(prisma);

    const okSock = makeSocket({ id: 'u-drv-1', role: 'DRIVER' });
    await expect(gw.onSubscribeTrip(okSock, { tripId: 'trip-1' })).resolves.toEqual({
      subscribed: 'trip:trip-1',
    });

    const badSock = makeSocket({ id: 'u-drv-2', role: 'DRIVER' });
    await expect(gw.onSubscribeTrip(badSock, { tripId: 'trip-1' })).rejects.toBeInstanceOf(
      WsException,
    );
  });

  it('allows admin roles to subscribe to any trip or job without DB restriction', async () => {
    const gw = makeGateway({ isConnected: () => true });
    const sock = makeSocket({ id: 'adm-1', role: 'SUPER_ADMIN' });
    await expect(gw.onSubscribeTrip(sock, { tripId: 'trip-99' })).resolves.toEqual({
      subscribed: 'trip:trip-99',
    });
    await expect(gw.onSubscribeJob(sock, { jobId: 'job-99' })).resolves.toEqual({
      subscribed: 'job:job-99',
    });
  });

  it('rejects unrelated carrier on subscribe:job and subscribe:fleet', async () => {
    const prisma = {
      isConnected: () => true,
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          senderCompanyId: 'comp-sender',
          assignment: { carrierCompanyId: 'comp-carrier-A', driverId: 'drv-1' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          companyId: 'comp-carrier-B',
          driver: null,
        }),
      },
    };
    const gw = makeGateway(prisma);
    const sock = makeSocket({ id: 'u-car-B', role: 'TRANSPORT_COMPANY' });
    await expect(gw.onSubscribeJob(sock, { jobId: 'job-1' })).rejects.toBeInstanceOf(WsException);
    await expect(gw.onSubscribeFleet(sock, { companyId: 'comp-carrier-A' })).rejects.toBeInstanceOf(
      WsException,
    );
  });
});
