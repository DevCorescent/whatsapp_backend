import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { CampaignHaltService } from './campaign-halt.service';
import { WebhookDispatchService } from '../webhook-dispatch.service';

/**
 * Global, because the two places that halt a campaign live in different apps: the send
 * processor in `campaigns` and the status webhook in `messaging`.
 *
 * `WebhookDispatchService` is listed here rather than imported, because it is provided
 * per-module across this codebase rather than globally. It holds nothing but Prisma, so
 * an instance of its own costs nothing. `RedisService` and `NotificationsService` come
 * from their own global modules.
 */
@Global()
@Module({
  imports:   [PrismaModule],
  providers: [CampaignHaltService, WebhookDispatchService],
  exports:   [CampaignHaltService],
})
export class CampaignHaltModule {}
