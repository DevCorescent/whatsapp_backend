import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { RedisIoAdapter } from '@lib/common';
import { GatewayModule } from './gateway.module';
import { GatewayService } from './gateway.service';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

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
  // The REST API is reached from the app's own origin and from every white-label
  // brand's, so a single origin string would refuse all but one of them. A list, the
  // platform root's subdomains, and localhost are all accepted; with nothing configured
  // it stays open, which is what a local run needs.
  const allowedOrigins = (process.env.FRONTEND_URL ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  const root = (process.env.PLATFORM_ROOT_DOMAIN ?? '').trim().toLowerCase();

  // A reseller's own domain is an origin nobody can list in advance, and the browser
  // opens the realtime socket against this server directly — so on a custom domain the
  // handshake was refused and messages stopped arriving live, with the rest of the app
  // working because it goes through Next's own proxy. The claimed domains are the
  // answer, cached so a preflight is not a database query.
  const gateway = app.get(GatewayService);
  const claimed = new Map<string, { at: number; ok: boolean }>();
  const CLAIM_TTL = 60_000;
  const isClaimed = async (host: string): Promise<boolean> => {
    const hit = claimed.get(host);
    if (hit && Date.now() - hit.at < CLAIM_TTL) return hit.ok;
    const ok = await gateway.isDomainAllowed(host).catch(() => false);
    claimed.set(host, { at: Date.now(), ok });
    return ok;
  };

  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
      let host = '';
      try { host = new URL(origin).hostname.toLowerCase(); } catch { /* malformed */ }
      const local = host === 'localhost' || host === '127.0.0.1';
      const brand = Boolean(root) && (host === root || host.endsWith('.' + root));
      if (local || brand) return cb(null, true);
      void isClaimed(host).then((ok) => cb(null, ok));
    },
    credentials: true,
  });

  // Socket.IO over Redis so realtime emits reach every gateway instance
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  // Global validation
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Wrap all responses in { success, data, pagination? } to match Next.js API shape
  app.useGlobalInterceptors(new TransformInterceptor());
  // One shape for every failure, so the sentence a refusal carries reaches the screen.
  app.useGlobalFilters(new HttpExceptionFilter());

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
