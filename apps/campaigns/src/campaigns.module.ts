import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '@lib/prisma';
import { QUEUE_CAMPAIGN_SEND, QUEUE_TEMPLATE_SYNC } from '@lib/queue';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignSendProcessor } from './processors/campaign-send.processor';
import { TemplatesModule } from './templates/templates.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    BullModule.forRootAsync({
      imports:    [ConfigModule],
      inject:     [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        redis: {
          host:     cfg.get('REDIS_HOST', 'localhost'),
          port:     cfg.get<number>('REDIS_PORT', 6379),
          password: cfg.get('REDIS_PASSWORD'),
          tls:      cfg.get('REDIS_TLS') === 'true' ? {} : undefined,
        },
      }),
    }),
    BullModule.registerQueue({ name: QUEUE_CAMPAIGN_SEND }),
    BullModule.registerQueue({ name: QUEUE_TEMPLATE_SYNC }),
    PrismaModule,
    TemplatesModule,
  ],
  controllers: [CampaignsController],
  providers:   [CampaignsService, CampaignSendProcessor],
})
export class CampaignsModule {}
