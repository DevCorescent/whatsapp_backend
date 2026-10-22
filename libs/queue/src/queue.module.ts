import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import {
  QUEUE_INBOUND_MESSAGE,
  QUEUE_AI_REPLY,
  QUEUE_CAMPAIGN_SEND,
  QUEUE_TEMPLATE_SYNC,
  QUEUE_RETENTION,
} from './queue.constants';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_INBOUND_MESSAGE },
      { name: QUEUE_AI_REPLY },
      { name: QUEUE_CAMPAIGN_SEND },
      { name: QUEUE_TEMPLATE_SYNC },
      { name: QUEUE_RETENTION },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
