import { NestFactory } from '@nestjs/core';
import { CampaignsModule } from './campaigns.module';

async function bootstrap() {
  const app = await NestFactory.create(CampaignsModule);
  await app.listen(process.env['CAMPAIGNS_PORT'] ?? 4003);
}

bootstrap().catch(console.error);
