import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { QUEUE_INBOUND_MESSAGE, QUEUE_MEDIA_FETCH } from '@lib/queue';
import { WebhookDispatchService } from '@lib/common';
import { PrismaModule } from '@lib/prisma';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { StatusBufferService } from './status-buffer.service';
import { InboundPipelineService } from './inbound-pipeline.service';
import { MediaFetchProcessor } from '../media/media-fetch.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_INBOUND_MESSAGE }),
    BullModule.registerQueue({ name: QUEUE_MEDIA_FETCH }),
    PrismaModule,
    ConfigModule,
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookDispatchService, StatusBufferService, InboundPipelineService, MediaFetchProcessor],
  exports: [StatusBufferService],
})
export class WebhookModule {}
