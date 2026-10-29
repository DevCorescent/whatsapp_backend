import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@lib/prisma';
import { WebhookDispatchService } from '@lib/common';
import { GatewayWebhookController } from './webhook.controller';
import { WebhookService } from '../../../../apps/messaging/src/webhook/webhook.service';
import { StatusBufferService } from '../../../../apps/messaging/src/webhook/status-buffer.service';
import { InboundPipelineService } from '../../../../apps/messaging/src/webhook/inbound-pipeline.service';
import { BillingService } from '../../../../apps/billing/src/billing.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [GatewayWebhookController],
  providers: [WebhookService, BillingService, WebhookDispatchService, StatusBufferService, InboundPipelineService],
})
export class GatewayWebhookModule {}
