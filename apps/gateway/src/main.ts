import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { GatewayModule } from './gateway.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

// Prevent ioredis retry errors from crashing the process when Redis is
// temporarily or permanently unreachable (e.g. TCP blocked on free-tier Upstash).
// The gateway runs fine without Redis — only campaign queueing is affected.
process.on('uncaughtException', (err: Error) => {
  if (
    err.message?.includes('ETIMEDOUT') ||
    err.message?.includes('ECONNREFUSED') ||
    err.message?.includes('ENOTFOUND')
  ) {
    console.error('[Redis] Uncaught connection error (campaigns unavailable):', err.message);
    return; // do not crash
  }
  console.error('Uncaught exception:', err);
  process.exit(1);
});

async function bootstrap() {
  // ── Redis config audit (Render log shows this on every deploy) ─────────────
  const redisHost = process.env.REDIS_HOST ?? '(not set)';
  const redisPort = process.env.REDIS_PORT ?? '(not set)';
  const redisTls  = process.env.REDIS_TLS  ?? '(not set)';
  const redisPass = process.env.REDIS_PASSWORD ? `set (${process.env.REDIS_PASSWORD.length} chars)` : '(NOT SET)';
  console.log(`[Redis] host=${redisHost} port=${redisPort} tls=${redisTls} password=${redisPass}`);

  // ── Verify Redis is reachable before accepting traffic ─────────────────────
  try {
    const Redis = (await import('ioredis')).default;
    const host     = process.env.REDIS_HOST ?? 'localhost';
    const port     = Number(process.env.REDIS_PORT ?? 6379);
    const password = process.env.REDIS_PASSWORD || undefined;
    const useTls   = process.env.REDIS_TLS === 'true';
    const probe    = new Redis({
      host, port, password,
      tls:                 useTls ? { servername: host } : undefined,
      connectTimeout:      8_000,
      enableReadyCheck:    false,
      maxRetriesPerRequest: 1,
      lazyConnect:         true,
    });
    await probe.connect();
    await probe.ping();
    await probe.quit();
    console.log(`[Redis] ✓ ping OK — ${host}:${port} tls=${useTls}`);
  } catch (err: any) {
    console.error(`[Redis] ✗ ping FAILED — ${err?.message}. Queues will not work until this is fixed.`);
  }

  const app = await NestFactory.create(GatewayModule, { rawBody: true });

  // Security
  app.use(helmet());
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? '*',
    credentials: true,
  });

  // Global validation
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Wrap all responses in { success, data, pagination? } to match Next.js API shape
  app.useGlobalInterceptors(new TransformInterceptor());

  // Swagger — available at /api/docs
  const config = new DocumentBuilder()
    .setTitle('WhatsCRM API')
    .setDescription('NestJS microservices backend for WhatsCRM')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  const port = process.env.PORT ?? process.env.GATEWAY_PORT ?? 4000;
  await app.listen(port);
  console.log(`Gateway running on http://localhost:${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap();
