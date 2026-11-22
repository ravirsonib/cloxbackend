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
import { Logger, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import type { AppEnv } from '../../config/env.validation';
import type { AppRole } from '../../shared/types';

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
  ) {}

  async handleConnection(client: Socket) {
    try {
      const principal = await this.authenticate(client);
      (client as any).principal = principal;
      if (['SUPER_ADMIN', 'STATE_MASTER', 'LOCAL_BDE'].includes(principal.role)) {
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
    @MessageBody() data: { tripId: string },
  ) {
    this.requireAuth(client);
    await client.join(rooms.trip(data.tripId));
    return { subscribed: rooms.trip(data.tripId) };
  }

  @SubscribeMessage(WS_EVENTS.SUBSCRIBE_FLEET)
  async onSubscribeFleet(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { companyId: string },
  ) {
    const principal = this.requireAuth(client);
    const isAdmin = ['SUPER_ADMIN', 'STATE_MASTER', 'LOCAL_BDE'].includes(principal.role);
    const isOwnCarrier =
      ['TRANSPORT_COMPANY'].includes(principal.role) &&
      (principal as any).companyId === data.companyId;
    if (!isAdmin && !isOwnCarrier) {
      throw new WsException('Forbidden');
    }
    await client.join(rooms.fleet(data.companyId));
    return { subscribed: rooms.fleet(data.companyId) };
  }

  @SubscribeMessage(WS_EVENTS.SUBSCRIBE_JOB)
  async onSubscribeJob(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { jobId: string },
  ) {
    this.requireAuth(client);
    await client.join(rooms.job(data.jobId));
    return { subscribed: rooms.job(data.jobId) };
  }

  @SubscribeMessage(WS_EVENTS.UNSUBSCRIBE_TRIP)
  async onUnsubscribeTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId: string },
  ) {
    await client.leave(rooms.trip(data.tripId));
    return { unsubscribed: rooms.trip(data.tripId) };
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

  emitEtaUpdate(payload: JobEtaPayload) {
    this.server?.to(rooms.job(payload.jobId))?.emit(WS_EVENTS.JOB_ETA_UPDATE, payload);
  }

  emitApproaching(payload: JobApproachingPayload, tripId: string) {
    this.server?.to(rooms.job(payload.jobId))?.to(rooms.trip(tripId))?.emit(WS_EVENTS.JOB_APPROACHING, payload);
  }

  private async authenticate(client: Socket): Promise<{ id: string; role: AppRole; companyId?: string }> {
    const token =
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

  private requireAuth(client: Socket): { id: string; role: AppRole; companyId?: string } {
    const principal = (client as any).principal;
    if (!principal) throw new WsException('Unauthorized');
    return principal;
  }
}

