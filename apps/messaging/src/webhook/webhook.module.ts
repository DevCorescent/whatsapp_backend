import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { QUEUE_INBOUND_MESSAGE } from '@lib/queue';
import { WebhookDispatchService, RedisPubSubService } from '@lib/common';
import { PrismaModule } from '@lib/prisma';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { StatusBufferService } from './status-buffer.service';
import { InboundPipelineService } from './inbound-pipeline.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_INBOUND_MESSAGE }),
    PrismaModule,
    ConfigModule,
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookDispatchService, StatusBufferService, InboundPipelineService, RedisPubSubService],
  exports: [StatusBufferService],
})
export class WebhookModule {}
