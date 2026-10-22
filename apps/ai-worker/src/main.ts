import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AiWorkerModule } from './ai-worker.module';

async function bootstrap() {
  // Workers don't expose an HTTP server — no listen needed
  const app = await NestFactory.createApplicationContext(AiWorkerModule);
  const cfg = app.get(ConfigService);

  console.log('AI worker running — consuming inbound-message and ai-reply queues');

  // Keep process alive
  process.on('SIGINT',  () => app.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
}

bootstrap().catch(console.error);
