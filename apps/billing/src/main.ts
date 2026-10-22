import { NestFactory } from '@nestjs/core';
import { BillingModule } from './billing.module';

async function bootstrap() {
  const app = await NestFactory.create(BillingModule);
  await app.listen(process.env['BILLING_PORT'] ?? 4005);
}

bootstrap().catch(console.error);
