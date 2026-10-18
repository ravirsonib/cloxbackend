import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware';
import { AppConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuditModule } from './modules/audit/audit.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { GeolocationModule } from './modules/geolocation/geolocation.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { LeadsModule } from './modules/leads/leads.module';
import { MatchingModule } from './modules/matching/matching.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OpsModule } from './modules/ops/ops.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SenderModule } from './modules/sender/sender.module';
import { CarrierModule } from './modules/carrier/carrier.module';
import { DriverModule } from './modules/driver/driver.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { TripsModule } from './modules/trips/trips.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        autoLogging: true,
        customProps: (req) => ({
          correlationId: req.headers['x-correlation-id'],
        }),
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('THROTTLE_TTL_MS', 60_000),
          limit: config.get<number>('THROTTLE_LIMIT', 10),
        },
      ],
    }),
    PrismaModule,
    HealthModule,
    LeadsModule,
    AuthModule,
    AdminModule,
    IdentityModule,
    SenderModule,
    CarrierModule,
    DriverModule,
    ComplianceModule,
    DocumentsModule,
    JobsModule,
    MatchingModule,
    TripsModule,
    PaymentsModule,
    SettlementsModule,
    GeolocationModule,
    NotificationsModule,
    OpsModule,
    AuditModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware, SecurityHeadersMiddleware).forRoutes('*');
  }
}
