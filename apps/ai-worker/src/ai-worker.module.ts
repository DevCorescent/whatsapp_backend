import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@lib/prisma';
import { RealtimeModule } from '@lib/common';
import { QUEUE_INBOUND_MESSAGE, QUEUE_AI_REPLY, QUEUE_CAMPAIGN_SEND, QUEUE_TEMPLATE_SYNC } from '@lib/queue';
import { WhatsAppApiService } from './whatsapp/whatsapp-api.service';
import { AiService } from './ai/ai.service';
import { InboundProcessor } from './processors/inbound.processor';
import { AiReplyProcessor } from './processors/ai-reply.processor';
import { CronService } from './cron/cron.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ScheduleModule.forRoot(),
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
    BullModule.registerQueue(
      { name: QUEUE_INBOUND_MESSAGE },
      { name: QUEUE_AI_REPLY },
      { name: QUEUE_CAMPAIGN_SEND },
      { name: QUEUE_TEMPLATE_SYNC },
    ),
    PrismaModule,
    // No sockets live in this process; RealtimeService falls back to the Redis emitter,
    // so a queue processor or cron here can push to a browser like the gateway does.
    RealtimeModule,
  ],
  providers: [
    WhatsAppApiService,
    AiService,
    InboundProcessor,
    AiReplyProcessor,
    CronService,
  ],
})
export class AiWorkerModule {}
