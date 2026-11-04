import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { V1Controller } from './v1.controller';
import { ApiKeyGuard } from './api-key.guard';
import { GatewayWebhookModule } from '../webhook/webhook.module';

@Module({
  imports:     [PrismaModule, GatewayWebhookModule],
  controllers: [V1Controller],
  providers:   [ApiKeyGuard],
})
export class ApiV1Module {}
