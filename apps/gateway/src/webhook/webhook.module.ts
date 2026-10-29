import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '@lib/prisma';
import { WebhookDispatchService } from '@lib/common';
import { QUEUE_MEDIA_FETCH } from '@lib/queue';
import { GatewayWebhookController } from './webhook.controller';
import { WebhookService } from '../../../../apps/messaging/src/webhook/webhook.service';
import { StatusBufferService } from '../../../../apps/messaging/src/webhook/status-buffer.service';
import { InboundPipelineService } from '../../../../apps/messaging/src/webhook/inbound-pipeline.service';
import { MediaFetchProcessor } from '../../../../apps/messaging/src/media/media-fetch.processor';
import { BillingService } from '../../../../apps/billing/src/billing.service';

@Module({
  imports: [PrismaModule, ConfigModule, BullModule.registerQueue({ name: QUEUE_MEDIA_FETCH })],
  controllers: [GatewayWebhookController],
  providers: [WebhookService, BillingService, WebhookDispatchService, StatusBufferService, InboundPipelineService, MediaFetchProcessor],
})
export class GatewayWebhookModule {}
