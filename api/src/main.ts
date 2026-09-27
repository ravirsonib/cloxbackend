import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import type { AppEnv } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<AppEnv, true>);
  const logger = app.get(Logger);

  app.useLogger(logger);
  app.setGlobalPrefix(config.get('API_PREFIX', { infer: true }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());

  const origins = config
    .get('CORS_ORIGINS', { infer: true })
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origins,
    credentials: true,
  });

  const nodeEnv = config.get('NODE_ENV', { infer: true });
  const enableOpenApi =
    config.get('ENABLE_OPENAPI', { infer: true }) || nodeEnv !== 'production';

  if (enableOpenApi) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('CLOX Pre-Launch API')
        .setDescription(
          'Phase 0 API: public leads (registry / EOI / investor), Super Admin OTP auth, and admin review.',
        )
        .setVersion('0.1.0')
        .addBearerAuth()
        .addTag('health')
        .addTag('leads')
        .addTag('auth')
        .addTag('admin')
        .build(),
    );
    SwaggerModule.setup('docs', app, document, {
      useGlobalPrefix: true,
    });
    logger.log('OpenAPI available at /v1/docs');
  }

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  logger.log(
    `CLOX API listening on http://localhost:${port}/${config.get('API_PREFIX', { infer: true })}`,
  );
}

void bootstrap();
