import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { MessagingModule } from './messaging.module';

async function bootstrap() {
  const app = await NestFactory.create(MessagingModule, {
    rawBody: true, // needed for HMAC verification on raw bytes
  });

  app.use(helmet());
  app.enableCors({ origin: '*' });

  const cfg = app.get(ConfigService);
  const port = cfg.get<number>('MESSAGING_PORT', 4001);

  await app.listen(port);
  console.log(`Messaging service running on http://localhost:${port}`);
}

bootstrap().catch(console.error);
