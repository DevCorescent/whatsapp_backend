import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '@lib/prisma';
import { WebhookDispatchService } from '@lib/common';
import { QUEUE_INBOUND_MESSAGE } from '@lib/queue';
import { GatewayWebhookController } from './webhook.controller';
import { WebhookService } from '../../../../apps/messaging/src/webhook/webhook.service';
import { StatusBufferService } from '../../../../apps/messaging/src/webhook/status-buffer.service';
import { BillingService } from '../../../../apps/billing/src/billing.service';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    BullModule.registerQueue({ name: QUEUE_INBOUND_MESSAGE }),
  ],
  controllers: [GatewayWebhookController],
  providers:   [WebhookService, BillingService, WebhookDispatchService, StatusBufferService],
})
export class GatewayWebhookModule {}
