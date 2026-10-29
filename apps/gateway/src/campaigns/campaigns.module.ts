import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '@lib/prisma';
import { WebhookDispatchService } from '@lib/common';
import { QUEUE_CAMPAIGN_SEND, QUEUE_TEMPLATE_SYNC } from '@lib/queue';
import { CampaignsController }      from '../../../../apps/campaigns/src/campaigns.controller';
import { CampaignsService }         from '../../../../apps/campaigns/src/campaigns.service';
import { TemplatesController }      from '../../../../apps/campaigns/src/templates/templates.controller';
import { TemplatesService }         from '../../../../apps/campaigns/src/templates/templates.service';
import { CampaignSendProcessor }    from '../../../../apps/campaigns/src/processors/campaign-send.processor';
import { TemplateSyncProcessor }    from '../../../../apps/campaigns/src/processors/template-sync.processor';
import { CampaignSchedulerService } from './campaign-scheduler.service';
import { CampaignDebugController }  from './campaign-debug.controller';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: QUEUE_CAMPAIGN_SEND }),
    BullModule.registerQueue({ name: QUEUE_TEMPLATE_SYNC }),
  ],
  controllers: [CampaignsController, TemplatesController, CampaignDebugController],
  providers:   [CampaignsService, TemplatesService, WebhookDispatchService, CampaignSendProcessor, TemplateSyncProcessor, CampaignSchedulerService],
})
export class CampaignsModule {}
