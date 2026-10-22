import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { WebhookDispatchService } from '@lib/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports:     [PrismaModule],
  controllers: [WebhooksController],
  providers:   [WebhooksService, WebhookDispatchService],
  exports:     [WebhooksService, WebhookDispatchService],
})
export class WebhooksModule {}
