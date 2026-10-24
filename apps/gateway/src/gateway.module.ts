import { Module } from '@nestjs/common';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
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
import { TicketsModule }      from './tickets/tickets.module';
import { WebhooksModule }     from './webhooks/webhooks.module';

@Module({
  controllers: [GatewayController],
  providers:   [GatewayService],
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),

    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const host     = cfg.get<string>('REDIS_HOST', 'localhost');
        const port     = cfg.get<number>('REDIS_PORT', 6379);
        const password = cfg.get<string>('REDIS_PASSWORD', '');
        const useTls   = cfg.get<string>('REDIS_TLS') === 'true';

        if (useTls && host && password) {
          // Upstash and other TLS-only Redis providers require the rediss:// URL form;
          // the separate host/port/tls object approach triggers MaxRetriesPerRequestError.
          return { url: `rediss://default:${encodeURIComponent(password)}@${host}:${port}` };
        }

        return { redis: { host, port, password: password || undefined } };
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
  ],
})
export class GatewayModule {}
