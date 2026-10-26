import { Module, Logger } from '@nestjs/common';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@lib/prisma';

// Core
import { AuthModule }         from './auth/auth.module';
import { SettingsModule }     from './settings/settings.module';
import { ApiV1Module }        from './api-v1/api-v1.module';
import { AdminModule }        from './admin/admin.module';
import { KnowledgeModule }    from './knowledge/knowledge.module';

// Cross-app modules (contacts / conversations / campaigns)
import { ContactsModule }      from './contacts/contacts.module';
import { ConversationsModule } from './conversations/conversations.module';
import { CampaignsModule }     from './campaigns/campaigns.module';

// URL-alias modules (match Next.js /api/* paths exactly)
import { GatewayBillingModule } from './billing/billing.module';
import { IntegrationsModule }   from './integrations/integrations.module';
import { MessagesModule }       from './messages/messages.module';
import { TeamModule }           from './team/team.module';
import { WalletModule }         from './wallet/wallet.module';

// Webhook (WhatsApp + payment providers)
import { GatewayWebhookModule } from './webhook/webhook.module';

// New modules
import { AccountModule }      from './account/account.module';
import { AiModule }           from './ai/ai.module';
import { AnalyticsModule }    from './analytics/analytics.module';
import { BlacklistModule }    from './blacklist/blacklist.module';
import { BusinessesModule }   from './businesses/businesses.module';
import { ChatbotModule }      from './chatbot/chatbot.module';
import { ExportModule }       from './export/export.module';
import { LeadsModule }        from './leads/leads.module';
import { MediaModule }        from './media/media.module';
import { NewsletterModule }   from './newsletter/newsletter.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OnboardingModule }   from './onboarding/onboarding.module';
import { QuickRepliesModule } from './quick-replies/quick-replies.module';
import { ResellerModule }     from './reseller/reseller.module';
import { SearchModule }       from './search/search.module';
import { SegmentsModule }     from './segments/segments.module';
import { TagsModule }         from './tags/tags.module';
import { TicketsModule }      from './tickets/tickets.module';
import { WebhooksModule }     from './webhooks/webhooks.module';
import { EventsModule }       from './events/events.module';

@Module({
  controllers: [GatewayController],
  providers:   [GatewayService],
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ScheduleModule.forRoot(),

    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const host     = cfg.get<string>('REDIS_HOST', 'localhost');
        const port     = cfg.get<number>('REDIS_PORT', 6379);
        const password = cfg.get<string>('REDIS_PASSWORD', '') || undefined;
        const useTls   = cfg.get<string>('REDIS_TLS') === 'true';
        const logger   = new Logger('BullRedis');

        logger.log(`Connecting to Redis host=${host} port=${port} tls=${useTls} password=${password ? `set(${password.length}ch)` : 'not set'}`);

        return {
          redis: {
            host,
            port: Number(port),
            password,
            tls:                  useTls ? { servername: host } : undefined,
            connectTimeout:       10_000,
            enableReadyCheck:     false,
            maxRetriesPerRequest: null as any,
            retryStrategy: (times: number) => {
              const delay = Math.min(times * 200, 5_000);
              if (times === 1 || times % 10 === 0) {
                logger.error(`Redis retry #${times} in ${delay}ms — check REDIS_HOST/PORT/PASSWORD/TLS env vars`);
              }
              return delay;
            },
          },
        };
      },
    }),

    PrismaModule,

    // Auth & API access
    AuthModule,
    ApiV1Module,

    // Core features
    SettingsModule,
    BusinessesModule,
    AccountModule,

    // Inbox & messaging
    KnowledgeModule,
    ChatbotModule,
    TicketsModule,
    QuickRepliesModule,

    // Contacts & CRM
    SegmentsModule,
    TagsModule,
    BlacklistModule,
    LeadsModule,

    // URL alias modules (match Next.js /api/* paths)
    GatewayBillingModule,
    IntegrationsModule,
    MessagesModule,
    TeamModule,
    WalletModule,

    // Contacts & conversations
    ContactsModule,
    ConversationsModule,

    // Campaigns, templates & media
    CampaignsModule,
    MediaModule,

    // Analytics & reporting
    AnalyticsModule,
    ExportModule,
    SearchModule,

    // AI
    AiModule,

    // Platform admin
    AdminModule,
    ResellerModule,

    // Integrations & webhooks
    WebhooksModule,
    GatewayWebhookModule,

    // Misc
    NewsletterModule,
    NotificationsModule,
    OnboardingModule,

    // Real-time SSE
    EventsModule,
  ],
})
export class GatewayModule {}
