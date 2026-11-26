import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  WsException,
} from '@nestjs/websockets';
import { Logger, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import type { AppEnv } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { isAdminRole, type AppRole } from '../../shared/types';

export const WS_EVENTS = {
  VEHICLE_LOCATION:   'vehicle:location',
  VEHICLE_ZONE_ENTRY: 'vehicle:zone-entry',
  VEHICLE_ZONE_EXIT:  'vehicle:zone-exit',
  VEHICLE_DEVIATION:  'vehicle:deviation',
  VEHICLE_ARRIVED:    'vehicle:arrived',
  JOB_ETA_UPDATE:     'job:eta-update',
  JOB_APPROACHING:    'job:approaching',
  SUBSCRIBE_TRIP:     'subscribe:trip',
  SUBSCRIBE_FLEET:    'subscribe:fleet',
  SUBSCRIBE_JOB:      'subscribe:job',
  UNSUBSCRIBE_TRIP:   'unsubscribe:trip',
} as const;

export interface VehicleLocationPayload {
  tripId: string;
  driverId: string;
  vehicleId?: string;
  lat: number;
  lng: number;
  snappedLat?: number;
  snappedLng?: number;
  speedKph?: number;
  heading?: number;
  timestamp: string;
}

export interface VehicleZonePayload {
  tripId: string;
  zoneId: string;
  zoneName: string;
  durationMs?: number;
  timestamp: string;
}

export interface VehicleDeviationPayload {
  tripId: string;
  deviationMeters: number;
  driverLat: number;
  driverLng: number;
  timestamp: string;
}

export interface VehicleArrivedPayload {
  tripId: string;
  jobStopId: string;
  stopType: string;
  timestamp: string;
}

export interface JobEtaPayload {
  jobId: string;
  nextStopId: string;
  etaMinutes: number;
  timestamp: string;
}

export interface JobApproachingPayload {
  jobId: string;
  minutesAway: number;
  timestamp: string;
}

export const rooms = {
  trip:  (tripId: string)    => `trip:${tripId}`,
  fleet: (companyId: string) => `fleet:${companyId}`,
  job:   (jobId: string)     => `job:${jobId}`,
  admin: ()                  => 'admin:all',
} as const;

@Injectable()
@WebSocketGateway({
  namespace: '/tracking',
  cors: { origin: '*', credentials: true },
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const principal = await this.authenticate(client);
      (client as Socket & { principal?: WsPrincipal }).principal = principal;
      if (isAdminRole(principal.role)) {
        await client.join(rooms.admin());
      }
      this.logger.debug(
        { socketId: client.id, role: principal.role },
        'WS client connected',
      );
    } catch (err) {
      this.logger.warn({ socketId: client.id, err }, 'WS auth failed — disconnecting');
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug({ socketId: client.id }, 'WS client disconnected');
  }

  @SubscribeMessage(WS_EVENTS.SUBSCRIBE_TRIP)
  async onSubscribeTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId?: string },
  ) {
    const principal = this.requireAuth(client);
    const tripId = typeof data?.tripId === 'string' ? data.tripId.trim() : '';
    if (!tripId) {
      throw new WsException('Invalid tripId');
    }
    await this.assertCanViewTrip(principal, tripId);
    await client.join(rooms.trip(tripId));
    return { subscribed: rooms.trip(tripId) };
  }

  @SubscribeMessage(WS_EVENTS.SUBSCRIBE_FLEET)
  async onSubscribeFleet(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { companyId?: string },
  ) {
    const principal = this.requireAuth(client);
    const companyId = typeof data?.companyId === 'string' ? data.companyId.trim() : '';
    if (!companyId) {
      throw new WsException('Invalid companyId');
    }
    await this.assertCanViewFleet(principal, companyId);
    await client.join(rooms.fleet(companyId));
    return { subscribed: rooms.fleet(companyId) };
  }

  @SubscribeMessage(WS_EVENTS.SUBSCRIBE_JOB)
  async onSubscribeJob(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { jobId?: string },
  ) {
    const principal = this.requireAuth(client);
    const jobId = typeof data?.jobId === 'string' ? data.jobId.trim() : '';
    if (!jobId) {
      throw new WsException('Invalid jobId');
    }
    await this.assertCanViewJob(principal, jobId);
    await client.join(rooms.job(jobId));
    return { subscribed: rooms.job(jobId) };
  }

  @SubscribeMessage(WS_EVENTS.UNSUBSCRIBE_TRIP)
  async onUnsubscribeTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId?: string },
  ) {
    const tripId = typeof data?.tripId === 'string' ? data.tripId.trim() : '';
    if (!tripId) return { unsubscribed: null };
    await client.leave(rooms.trip(tripId));
    return { unsubscribed: rooms.trip(tripId) };
  }

  emitVehicleLocation(payload: VehicleLocationPayload, companyId?: string) {
    const tripRoom = rooms.trip(payload.tripId);
    this.server?.to(tripRoom)?.to(rooms.admin())?.emit(WS_EVENTS.VEHICLE_LOCATION, payload);
    if (companyId) {
      this.server?.to(rooms.fleet(companyId))?.emit(WS_EVENTS.VEHICLE_LOCATION, payload);
    }
  }

  emitZoneEntry(payload: VehicleZonePayload, companyId?: string) {
    this.server?.to(rooms.trip(payload.tripId))?.to(rooms.admin())?.emit(WS_EVENTS.VEHICLE_ZONE_ENTRY, payload);
    if (companyId) {
      this.server?.to(rooms.fleet(companyId))?.emit(WS_EVENTS.VEHICLE_ZONE_ENTRY, payload);
    }
  }

  emitZoneExit(payload: VehicleZonePayload, companyId?: string) {
    this.server?.to(rooms.trip(payload.tripId))?.to(rooms.admin())?.emit(WS_EVENTS.VEHICLE_ZONE_EXIT, payload);
    if (companyId) {
      this.server?.to(rooms.fleet(companyId))?.emit(WS_EVENTS.VEHICLE_ZONE_EXIT, payload);
    }
  }

  emitDeviation(payload: VehicleDeviationPayload, companyId?: string) {
    this.server?.to(rooms.trip(payload.tripId))?.to(rooms.admin())?.emit(WS_EVENTS.VEHICLE_DEVIATION, payload);
    if (companyId) {
      this.server?.to(rooms.fleet(companyId))?.emit(WS_EVENTS.VEHICLE_DEVIATION, payload);
    }
  }

  emitArrived(payload: VehicleArrivedPayload, jobId?: string) {
    this.server?.to(rooms.trip(payload.tripId))?.to(rooms.admin())?.emit(WS_EVENTS.VEHICLE_ARRIVED, payload);
    if (jobId) {
      this.server?.to(rooms.job(jobId))?.emit(WS_EVENTS.VEHICLE_ARRIVED, payload);
    }
  }

  emitEtaUpdate(payload: JobEtaPayload, tripId?: string) {
    const emitter = this.server?.to(rooms.job(payload.jobId));
    if (tripId) {
      emitter?.to(rooms.trip(tripId))?.emit(WS_EVENTS.JOB_ETA_UPDATE, payload);
      return;
    }
    emitter?.emit(WS_EVENTS.JOB_ETA_UPDATE, payload);
  }

  emitApproaching(payload: JobApproachingPayload, tripId: string) {
    this.server?.to(rooms.job(payload.jobId))?.to(rooms.trip(tripId))?.emit(WS_EVENTS.JOB_APPROACHING, payload);
  }

  private async resolveUserAffiliation(principal: WsPrincipal): Promise<{
    companyId: string | null;
    driverId: string | null;
  }> {
    if (!this.prisma || !this.prisma.isConnected()) {
      return { companyId: principal.companyId ?? null, driverId: null };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      select: { companyId: true, driver: { select: { id: true } } },
    });
    return {
      companyId: user?.companyId ?? principal.companyId ?? null,
      driverId: user?.driver?.id ?? null,
    };
  }

  private async assertCanViewTrip(principal: WsPrincipal, tripId: string): Promise<void> {
    if (isAdminRole(principal.role)) return;
    if (!this.prisma || !this.prisma.isConnected()) {
      throw new WsException('Forbidden');
    }
    const [trip, affiliation] = await Promise.all([
      this.prisma.trip.findUnique({
        where: { id: tripId },
        select: {
          id: true,
          job: { select: { senderCompanyId: true } },
          assignment: { select: { carrierCompanyId: true, driverId: true } },
        },
      }),
      this.resolveUserAffiliation(principal),
    ]);
    if (!trip) throw new WsException('Forbidden');

    const allowed =
      (principal.role === 'SENDER' &&
        Boolean(affiliation.companyId) &&
        trip.job.senderCompanyId === affiliation.companyId) ||
      (principal.role === 'TRANSPORT_COMPANY' &&
        Boolean(affiliation.companyId) &&
        trip.assignment?.carrierCompanyId === affiliation.companyId) ||
      (principal.role === 'DRIVER' &&
        Boolean(affiliation.driverId) &&
        trip.assignment?.driverId === affiliation.driverId);

    if (!allowed) {
      throw new WsException('Forbidden');
    }
  }

  private async assertCanViewJob(principal: WsPrincipal, jobId: string): Promise<void> {
    if (isAdminRole(principal.role)) return;
    if (!this.prisma || !this.prisma.isConnected()) {
      throw new WsException('Forbidden');
    }
    const [job, affiliation] = await Promise.all([
      this.prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          senderCompanyId: true,
          assignment: { select: { carrierCompanyId: true, driverId: true } },
        },
      }),
      this.resolveUserAffiliation(principal),
    ]);
    if (!job) throw new WsException('Forbidden');

    const allowed =
      (principal.role === 'SENDER' &&
        Boolean(affiliation.companyId) &&
        job.senderCompanyId === affiliation.companyId) ||
      (principal.role === 'TRANSPORT_COMPANY' &&
        Boolean(affiliation.companyId) &&
        job.assignment?.carrierCompanyId === affiliation.companyId) ||
      (principal.role === 'DRIVER' &&
        Boolean(affiliation.driverId) &&
        job.assignment?.driverId === affiliation.driverId);

    if (!allowed) {
      throw new WsException('Forbidden');
    }
  }

  private async assertCanViewFleet(principal: WsPrincipal, companyId: string): Promise<void> {
    if (isAdminRole(principal.role)) return;
    if (principal.role !== 'TRANSPORT_COMPANY') {
      throw new WsException('Forbidden');
    }
    const affiliation = await this.resolveUserAffiliation(principal);
    if (!affiliation.companyId || affiliation.companyId !== companyId) {
      throw new WsException('Forbidden');
    }
  }

  private async authenticate(client: Socket): Promise<WsPrincipal> {
    const authToken =
      typeof client.handshake.auth?.token === 'string'
        ? client.handshake.auth.token
        : undefined;
    const token =
      authToken ||
      (client.handshake.query?.token as string) ||
      (client.handshake.headers?.authorization as string)?.replace(/^Bearer\s+/i, '');

    if (!token) throw new WsException('Missing token');

    const payload = await this.jwt
      .verifyAsync<{ sub: string; role: AppRole; typ: string; companyId?: string }>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      })
      .catch(() => {
        throw new WsException('Invalid token');
      });

    if (payload.typ !== 'access') throw new WsException('Invalid token type');
    return { id: payload.sub, role: payload.role, companyId: payload.companyId };
  }

  private requireAuth(client: Socket): WsPrincipal {
    const principal = (client as Socket & { principal?: WsPrincipal }).principal;
    if (!principal) throw new WsException('Unauthorized');
    return principal;
  }
}

type WsPrincipal = { id: string; role: AppRole; companyId?: string };

