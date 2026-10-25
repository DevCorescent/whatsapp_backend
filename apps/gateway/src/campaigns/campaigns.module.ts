import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '@lib/prisma';
import { WebhookDispatchService } from '@lib/common';
import { QUEUE_CAMPAIGN_SEND, QUEUE_TEMPLATE_SYNC } from '@lib/queue';
import { CampaignsController }  from '../../../../apps/campaigns/src/campaigns.controller';
import { CampaignsService }     from '../../../../apps/campaigns/src/campaigns.service';
import { TemplatesController }  from '../../../../apps/campaigns/src/templates/templates.controller';
import { TemplatesService }     from '../../../../apps/campaigns/src/templates/templates.service';
// Processors (queue consumers) are intentionally excluded here — they run only
// in the campaigns worker app to avoid double-processing queued jobs.

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: QUEUE_CAMPAIGN_SEND }),
    BullModule.registerQueue({ name: QUEUE_TEMPLATE_SYNC }),
  ],
  controllers: [CampaignsController, TemplatesController],
  providers:   [CampaignsService, TemplatesService, WebhookDispatchService],
})
export class CampaignsModule {}
