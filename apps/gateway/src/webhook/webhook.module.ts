import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '@lib/prisma';
import { WebhookDispatchService } from '@lib/common';
import { QUEUE_MEDIA_FETCH, QUEUE_CALLS } from '@lib/queue';
import { GatewayWebhookController } from './webhook.controller';
import { WebhookService } from '../../../../apps/messaging/src/webhook/webhook.service';
import { StatusBufferService } from '../../../../apps/messaging/src/webhook/status-buffer.service';
import { InboundPipelineService } from '../../../../apps/messaging/src/webhook/inbound-pipeline.service';
import { MediaFetchProcessor } from '../../../../apps/messaging/src/media/media-fetch.processor';
import { CallsWebhookService } from '../../../../apps/messaging/src/calls/calls-webhook.service';
import { BillingService } from '../../../../apps/billing/src/billing.service';
import { CallsModule } from '../calls/calls.module';

@Module({
  imports: [
    PrismaModule, ConfigModule, CallsModule,
    BullModule.registerQueue({ name: QUEUE_MEDIA_FETCH }),
    BullModule.registerQueue({ name: QUEUE_CALLS }),
  ],
  controllers: [GatewayWebhookController],
  providers: [WebhookService, BillingService, WebhookDispatchService, StatusBufferService, InboundPipelineService, MediaFetchProcessor, CallsWebhookService],
  exports: [InboundPipelineService],
})
export class GatewayWebhookModule {}
