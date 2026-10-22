import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports:     [PrismaModule],
  controllers: [WebhooksController],
  providers:   [WebhooksService],
  exports:     [WebhooksService],
})
export class WebhooksModule {}
