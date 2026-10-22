import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { QUEUE_INBOUND_MESSAGE } from '@lib/queue';
import { WebhookDispatchService } from '@lib/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_INBOUND_MESSAGE }),
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookDispatchService],
})
export class WebhookModule {}
