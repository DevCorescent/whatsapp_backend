import {
  Injectable, NotFoundException, ForbiddenException, ConflictException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import {
  TenantScope, decryptSecret, encryptSecret, sanitizeWhatsAppToken, isMetaAccessToken,
  MessageRatesService, PermissionsService, PERMISSIONS, INVITABLE_ROLES, TEAM_ADMIN_ROLES,
  MailService,
  accountCeiling, roleDefaults, resolvePermission, isInvitableRole,
  parseSendError, classifySendError, isKnownSendError,
} from '@lib/common';

/** The role names a person would recognise, rather than the stored value. */
const ROLE_LABELS: Record<string, string> = {
  ADMIN:          'Administrator',
  MANAGER:        'Manager',
  MARKETING_USER: 'Marketing',
  AGENT:          'Agent',
};

/**
 * The note sent when somebody is added to a workspace.
 *
 * It carries no password and no link that grants anything: the recipient already has an
 * account, and this only tells them where the new workspace appears.
 */
function inviteEmail(d: {
  name: string; workspace: string; role: string; rejoined: boolean; appUrl: string;
}): string {
  const action = d.rejoined ? 'been given access again to' : 'been added to';
  const button = d.appUrl
    ? `<p style="margin:26px 0"><a href="${d.appUrl}/login" style="background:#0B6E4F;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Open ${d.workspace}</a></p>`
    : '';
  return `
<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1A2B32;max-width:560px">
  <p>Hi ${escapeHtml(d.name)},</p>
  <p>You have ${action} <strong>${escapeHtml(d.workspace)}</strong> as <strong>${escapeHtml(d.role)}</strong>.</p>
  <p>Sign in with the password you already use. ${escapeHtml(d.workspace)} will appear in the
     workspace switcher at the bottom of the sidebar, alongside any others you belong to.</p>
  ${button}
  <p style="color:#5B6B73;font-size:13px">If you were not expecting this, you can ignore this message &mdash;
     nothing about your existing access has changed.</p>
</div>`.trim();
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rates:  MessageRatesService,
    private readonly mail: MailService,
    private readonly permissions: PermissionsService,
  ) {}

  // ── Opt-out / Opt-in Manager ──────────────────────────────────────────────────

  async getOptOutConfig(scope: TenantScope) {
    const biz = await this.prisma.business.findFirst({
      where:  { id: scope.businessId },
      select: { aiInstructions: true },
    });
    const cfg = ((biz?.aiInstructions as any)?.optOutConfig ?? {}) as Record<string, any>;
    return {
      optOutKeywords: cfg.optOutKeywords ?? ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT'],
      optInKeywords:  cfg.optInKeywords  ?? ['START', 'SUBSCRIBE', 'YES'],
      optOutReply:    cfg.optOutReply    ?? 'You have been unsubscribed and will no longer receive marketing messages from us. Reply START to re-subscribe.',
      optInReply:     cfg.optInReply     ?? 'You have been re-subscribed and will receive messages from us again. Reply STOP to unsubscribe.',
    };
  }

  async updateOptOutConfig(scope: TenantScope, data: {
    optOutKeywords?: string[];
    optInKeywords?:  string[];
    optOutReply?:    string;
    optInReply?:     string;
  }) {
    const biz = await this.prisma.business.findFirst({
      where:  { id: scope.businessId },
      select: { aiInstructions: true },
    });
    const existing = ((biz?.aiInstructions as any) ?? {}) as Record<string, unknown>;
    await this.prisma.business.update({
      where: { id: scope.businessId },
      data:  { aiInstructions: { ...existing, optOutConfig: data } },
    });
    return { success: true };
  }

  // ── Combined settings (matches Next.js /api/settings GET/PATCH) ──────────────

  async getSettings(scope: TenantScope) {
    const [biz, ts] = await Promise.all([
      this.getBusiness(scope),
      this.prisma.tenantSettings.findUnique({
        where:  { tenantId: scope.tenantId },
        select: {
          timezone: true, businessHoursStart: true, businessHoursEnd: true, businessDays: true,
          smtpHost: true, smtpPort: true, smtpUser: true, smtpFrom: true, smtpPass: true,
        },
      }),
    ]);

    // Social links are stored inside aiInstructions under a socialLinks key
    // (no dedicated metadata field exists on Business or TenantSettings).
    const aiInstr = (biz as any).aiInstructions as Record<string, unknown> | null | undefined;
    const sl      = (aiInstr?.socialLinks ?? {}) as Record<string, string>;

    return {
      name:               biz.name,
      timezone:           (ts as any)?.timezone ?? (biz as any).timezone,
      businessHoursStart: (ts as any)?.businessHoursStart ?? null,
      businessHoursEnd:   (ts as any)?.businessHoursEnd ?? null,
      businessDays:       (ts as any)?.businessDays ?? null,
      smtpHost:           (ts as any)?.smtpHost ?? null,
      smtpPort:           (ts as any)?.smtpPort ?? null,
      smtpUser:           (ts as any)?.smtpUser ?? null,
      smtpFrom:           (ts as any)?.smtpFrom ?? null,
      // The password itself never comes back; the form only needs to know one is stored
      // so it can leave the field blank without clearing what is saved.
      smtpPassSet:        Boolean((ts as any)?.smtpPass),
      logo:               (biz as any).logoUrl,
      autoReply:          (biz as any).autoReply,
      autoReplyDelay:     (biz as any).autoReplyDelay,
      offHoursMessage:    (biz as any).offHoursMessage,
      aiEnabled:          (biz as any).aiEnabled,
      aiModel:            (biz as any).aiModel,
      aiSystemPrompt:     (biz as any).aiSystemPrompt,
      aiPersonality:      (biz as any).aiPersonality,
      aiResponseTone:     (biz as any).aiResponseTone,
      aiTemperature:      (biz as any).aiTemperature,
      aiMaxTokens:        (biz as any).aiMaxTokens,
      socialLinks: {
        facebook:  sl.facebook  ?? '',
        instagram: sl.instagram ?? '',
        twitter:   sl.twitter   ?? '',
        linkedin:  sl.linkedin  ?? '',
        website:   sl.website   ?? '',
      },
    };
  }

  async updateSettings(scope: TenantScope, data: Record<string, unknown>) {
    await this.getBusiness(scope);

    // Route each field to the correct table:
    // - businessHoursStart/End/Days, timezone, wa*, smtp* → tenant_settings
    // - tenantName, logo, domain → tenant
    // - socialLinks → business.aiInstructions (stored under socialLinks key)
    // - everything else → business
    const {
      businessHoursStart, businessHoursEnd, businessDays, timezone,
      waPhoneNumberId, waBusinessAccountId, waApiKey, waAppSecret, waWebhookVerifyToken,
      smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom,
      tenantName, logo, domain,
      socialLinks,
      ...bizData
    } = data as any;

    // If socialLinks is provided, merge it into the existing aiInstructions JSON.
    // This must happen before the parallel writes so we can read the current value.
    if (socialLinks !== undefined) {
      const current = await this.prisma.business.findUnique({
        where:  { id: scope.businessId },
        select: { aiInstructions: true },
      });
      const existing = (current?.aiInstructions as Record<string, unknown>) ?? {};
      bizData.aiInstructions = { ...existing, socialLinks };
    }

    const writes: Promise<unknown>[] = [];

    // Business fields (offHoursMessage, autoReply, aiInstructions with socialLinks, etc.)
    if (Object.keys(bizData).length > 0) {
      writes.push(this.prisma.business.update({ where: { id: scope.businessId }, data: bizData }));
    }

    // TenantSettings fields
    const tsData: Record<string, unknown> = {};
    if (businessHoursStart !== undefined) tsData.businessHoursStart = businessHoursStart;
    if (businessHoursEnd   !== undefined) tsData.businessHoursEnd   = businessHoursEnd;
    if (businessDays        !== undefined) tsData.businessDays        = businessDays;
    if (timezone            !== undefined) tsData.timezone            = timezone;

    // WhatsApp credentials — blank values mean "leave as-is", not "erase"
    if (waPhoneNumberId    !== undefined) tsData.waPhoneNumberId    = waPhoneNumberId;
    if (waBusinessAccountId !== undefined) tsData.waBusinessAccountId = waBusinessAccountId;
    if (waWebhookVerifyToken && (waWebhookVerifyToken as string).trim()) {
      tsData.waWebhookVerifyToken = encryptSecret((waWebhookVerifyToken as string).trim());
    }
    if (waApiKey && (waApiKey as string).trim()) {
      const cleaned = sanitizeWhatsAppToken(waApiKey as string);
      if (cleaned && isMetaAccessToken(cleaned)) {
        tsData.waApiKey = encryptSecret(cleaned);
      }
    }
    if (waAppSecret && (waAppSecret as string).trim()) {
      tsData.waAppSecret = encryptSecret((waAppSecret as string).trim());
    }

    // SMTP credentials
    if (smtpHost !== undefined) tsData.smtpHost = smtpHost;
    if (smtpPort !== undefined) tsData.smtpPort = smtpPort;
    if (smtpUser !== undefined) tsData.smtpUser = smtpUser;
    if (smtpFrom !== undefined) tsData.smtpFrom = smtpFrom;
    if (smtpPass && (smtpPass as string).trim()) {
      tsData.smtpPass = encryptSecret((smtpPass as string).trim());
    }

    if (Object.keys(tsData).length > 0) {
      writes.push(
        this.prisma.tenantSettings.upsert({
          where:  { tenantId: scope.tenantId },
          create: { tenantId: scope.tenantId, ...tsData },
          update: tsData,
        }),
      );
    }

    // Tenant-level fields (name, logo, custom domain)
    if (tenantName || logo || domain) {
      const tenantData: Record<string, unknown> = {};
      if (tenantName) tenantData.name   = String(tenantName);
      if (logo)       tenantData.logo   = String(logo);
      if (domain)     tenantData.domain = String(domain);
      writes.push(this.prisma.tenant.update({ where: { id: scope.tenantId }, data: tenantData }));
    }

    const [result] = await Promise.all(writes);
    return result ?? {};
  }

  // ── Message Rates ──────────────────────────────────────────────────────────

  /**
   * What this workspace is charged per message, and where each price comes from.
   *
   * Read-only on purpose. This used to return the platform rows and let any tenant admin
   * write them, which meant a customer could set its own message price — including to
   * zero. Platform pricing now lives behind the super-admin screens only.
   */
  async getMessageRates(scope: TenantScope) {
    const rates = await this.rates.resolveAll(scope.tenantId);
    return rates.map(r => ({
      category:      r.category,
      priceMinor:    r.priceMinor,
      source:        r.source,
      platformMinor: r.platformMinor,
      resellerMinor: r.resellerMinor,
      customerMinor: r.customerMinor,
    }));
  }

  /** Only the platform owner may change prices; everyone else sees them read-only. */
  async updateMessageRates(
    scope: TenantScope,
    rates: Array<{ category: string; priceMinor: number }>,
  ) {
    if (scope.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Message prices are set by the platform. Contact your account manager to change them.');
    }
    for (const rate of rates) {
      await this.rates.setPlatform(rate.category, rate.priceMinor);
    }
    return this.rates.listPlatform();
  }

  // ── Business / AI settings ─────────────────────────────────────────────────

  async getBusiness(scope: TenantScope) {
    const biz = await this.prisma.business.findFirst({
      where: { id: scope.businessId, tenantId: scope.tenantId },
    });
    if (!biz) throw new NotFoundException('Business not found');
    return biz;
  }

  async getAiSettings(scope: TenantScope) {
    const { tenantId, businessId } = scope;
    const [settings, business] = await Promise.all([
      this.prisma.tenantSettings.upsert({
        where:  { tenantId },
        create: { tenantId },
        update: {},
        select: { aiEnabled: true, aiModel: true, autoReply: true, autoReplyDelay: true, aiPersonality: true },
      }),
      this.prisma.business.findUnique({
        where:  { id: businessId },
        select: { aiTemperature: true, aiMaxTokens: true, aiSystemPrompt: true, aiInstructions: true, aiResponseTone: true, offHoursMessage: true, name: true },
      }),
    ]);
    const { name: businessName, ...businessSettings } = business ?? { name: null };
    const useOpenRouter = !!(process.env.OPENROUTER_API_KEY);
    const provider = useOpenRouter ? 'openrouter' : 'groq';
    const defaultModel = useOpenRouter
      ? (process.env.OPENROUTER_MODEL ?? 'meta-llama/llama-3.3-70b-instruct')
      : (process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile');
    return { ...settings, ...businessSettings, businessName, provider, defaultModel };
  }

  async updateAiSettings(scope: TenantScope, data: {
    aiEnabled?: boolean; aiModel?: string; aiSystemPrompt?: string;
    aiInstructions?: unknown; aiPersonality?: string; aiResponseTone?: string;
    aiTemperature?: number; aiMaxTokens?: number;
    autoReply?: boolean; autoReplyDelay?: number; offHoursMessage?: string;
  }) {
    await this.getBusiness(scope); // 404 guard

    // Split writes to match the Next.js schema split:
    // TenantSettings: aiEnabled, aiModel, autoReply, autoReplyDelay, aiPersonality
    // Business:       aiSystemPrompt, aiInstructions, aiResponseTone, aiTemperature, aiMaxTokens, offHoursMessage
    const tenantData: Record<string, unknown> = {};
    if (data.aiEnabled      !== undefined) tenantData.aiEnabled      = data.aiEnabled;
    if (data.aiModel        !== undefined) tenantData.aiModel        = data.aiModel;
    if (data.autoReply      !== undefined) tenantData.autoReply      = data.autoReply;
    if (data.autoReplyDelay !== undefined) tenantData.autoReplyDelay = data.autoReplyDelay;
    if (data.aiPersonality  !== undefined) tenantData.aiPersonality  = data.aiPersonality;

    const bizData: Record<string, unknown> = {};
    if (data.aiSystemPrompt  !== undefined) bizData.aiSystemPrompt  = data.aiSystemPrompt;
    if (data.aiInstructions  !== undefined) bizData.aiInstructions  = data.aiInstructions;
    if (data.aiResponseTone  !== undefined) bizData.aiResponseTone  = data.aiResponseTone;
    if (data.aiTemperature   !== undefined) bizData.aiTemperature   = data.aiTemperature;
    if (data.aiMaxTokens     !== undefined) bizData.aiMaxTokens     = data.aiMaxTokens;
    if (data.offHoursMessage !== undefined) bizData.offHoursMessage = data.offHoursMessage;

    const [settings, business] = await Promise.all([
      Object.keys(tenantData).length > 0
        ? this.prisma.tenantSettings.upsert({
            where:  { tenantId: scope.tenantId },
            create: { tenantId: scope.tenantId, ...tenantData },
            update: tenantData,
            select: { aiEnabled: true, aiModel: true, autoReply: true, autoReplyDelay: true, aiPersonality: true },
          })
        : this.prisma.tenantSettings.findUnique({
            where:  { tenantId: scope.tenantId },
            select: { aiEnabled: true, aiModel: true, autoReply: true, autoReplyDelay: true, aiPersonality: true },
          }),
      Object.keys(bizData).length > 0
        ? this.prisma.business.update({
            where:  { id: scope.businessId },
            data:   bizData,
            select: { aiSystemPrompt: true, aiInstructions: true, aiResponseTone: true, aiTemperature: true, aiMaxTokens: true, offHoursMessage: true },
          })
        : this.prisma.business.findUnique({
            where:  { id: scope.businessId },
            select: { aiSystemPrompt: true, aiInstructions: true, aiResponseTone: true, aiTemperature: true, aiMaxTokens: true, offHoursMessage: true },
          }),
    ]);

    return { ...(settings ?? {}), ...(business ?? {}) };
  }

  // ── WhatsApp integrations ──────────────────────────────────────────────────

  async listIntegrations(scope: TenantScope, businessId?: string) {
    const bizId = businessId ?? scope.businessId;

    // This is the page someone opens to check their numbers, so a dropped pooled socket
    // here reads as "my numbers are gone". Worth the retry.
    const [business, integrations] = await this.prisma.withRetry(() => Promise.all([
      this.prisma.business.findFirst({
        where: { id: bizId, tenantId: scope.tenantId },
        select: { id: true, name: true, whatsappPhoneNumberId: true, whatsappAccessToken: true },
      }),
      this.prisma.whatsAppIntegration.findMany({
        where: { tenantId: scope.tenantId, businessId: bizId },
        orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
      }),
    ]), 'listIntegrations');

    if (!business) throw new NotFoundException('Business not found');

    const hasLegacyCredentials =
      Boolean(business.whatsappPhoneNumberId && business.whatsappAccessToken) &&
      !integrations.some((i) => i.phoneNumberId === business.whatsappPhoneNumberId);

    // Strip sensitive credential fields before returning to the client
    const safeIntegrations = integrations.map(({ accessToken: _a, appSecret: _s, verifyToken: _v, ...rest }) => rest);

    return {
      business: { id: business.id, name: business.name },
      integrations: safeIntegrations,
      hasLegacyCredentials,
    };
  }

  async getIntegration(scope: TenantScope, id: string) {
    const int = await this.prisma.whatsAppIntegration.findFirst({
      where: { id, tenantId: scope.tenantId, businessId: scope.businessId },
    });
    if (!int) throw new NotFoundException('WhatsApp integration not found');
    return int;
  }

  async createIntegration(scope: TenantScope, data: {
    displayName?: string; phoneNumber?: string; phoneNumberId: string;
    whatsappBusinessId: string; accessToken: string; verifyToken?: string;
    appSecret?: string;
  }) {
    return this.prisma.whatsAppIntegration.create({
      data: {
        tenantId:           scope.tenantId,
        businessId:         scope.businessId,
        displayName:        data.displayName,
        phoneNumber:        data.phoneNumber,
        phoneNumberId:      data.phoneNumberId,
        whatsappBusinessId: data.whatsappBusinessId,
        accessToken:        data.accessToken,
        verifyToken:        data.verifyToken,
        appSecret:          data.appSecret,
      },
    });
  }

  async updateIntegration(scope: TenantScope, id: string, data: {
    displayName?: string; accessToken?: string; verifyToken?: string;
    appSecret?: string; isActive?: boolean; isDefault?: boolean;
  }) {
    const existing = await this.getIntegration(scope, id); // 404 guard

    // A business has exactly one default number, enforced by a partial unique index.
    // Promoting one therefore has to demote the other in the same transaction, or the
    // insert collides and the whole request fails.
    if (data.isDefault === true) {
      return this.prisma.$transaction(async (tx) => {
        await tx.whatsAppIntegration.updateMany({
          where: { businessId: existing.businessId, isDefault: true, id: { not: id } },
          data:  { isDefault: false },
        });
        return tx.whatsAppIntegration.update({ where: { id }, data });
      });
    }

    // Removing the last default would leave the business with none, and every path that
    // looks one up — template import, status refresh — would start failing.
    if (data.isDefault === false && existing.isDefault) {
      throw new BadRequestException(
        'Make another number the default instead. A workspace always needs one.',
      );
    }

    // Switching off the number that is currently the default has the same effect.
    if (data.isActive === false && existing.isDefault) {
      const replacement = await this.prisma.whatsAppIntegration.findFirst({
        where:  { businessId: existing.businessId, isActive: true, id: { not: id } },
        select: { id: true },
      });
      if (!replacement) {
        throw new BadRequestException(
          'This is the only active number. Connect another before switching it off.',
        );
      }
      return this.prisma.$transaction(async (tx) => {
        await tx.whatsAppIntegration.update({ where: { id }, data: { ...data, isDefault: false } });
        await tx.whatsAppIntegration.update({ where: { id: replacement.id }, data: { isDefault: true } });
        return tx.whatsAppIntegration.findUnique({ where: { id } });
      });
    }

    return this.prisma.whatsAppIntegration.update({ where: { id }, data });
  }

  async deleteIntegration(scope: TenantScope, id: string) {
    await this.getIntegration(scope, id);
    await this.prisma.whatsAppIntegration.delete({ where: { id } });
    return { deleted: true };
  }

  // ── WhatsApp Embedded Signup / connection flows ────────────────────────────

  getWhatsAppConfig(_scope: TenantScope) {
    const REQUIRED_VARS = ['WHATSAPP_APP_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ES_CONFIG_ID'] as const;
    const missing = REQUIRED_VARS.filter(k => !process.env[k]?.trim());
    const appId    = process.env.WHATSAPP_APP_ID?.trim();
    const configId = process.env.WHATSAPP_ES_CONFIG_ID?.trim();
    const graphVersion = process.env.WHATSAPP_API_VERSION ?? 'v19.0';

    if (!appId || !configId || missing.length > 0) {
      return { enabled: false, missing };
    }
    return { enabled: true, appId, configId, graphVersion, missing: [] as string[] };
  }

  async connectEmbeddedSignup(scope: TenantScope, data: {
    code: string; phoneNumberId: string; wabaId: string;
  }) {
    const appId     = process.env.WHATSAPP_APP_ID;
    const appSecret = process.env.WHATSAPP_APP_SECRET;

    let accessToken = '';
    try {
      const url = `https://graph.facebook.com/v20.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${data.code}`;
      const res: any = await fetch(url);
      if (res.ok) {
        const json: any = await res.json();
        accessToken = json.access_token ?? '';
      }
    } catch {
      // fallback: token remains empty; caller can re-try
    }

    return this.prisma.whatsAppIntegration.upsert({
      where:  { phoneNumberId: data.phoneNumberId },
      create: {
        tenantId:           scope.tenantId,
        businessId:         scope.businessId,
        phoneNumberId:      data.phoneNumberId,
        whatsappBusinessId: data.wabaId,
        accessToken,
        isActive:           true,
      },
      update: {
        whatsappBusinessId: data.wabaId,
        accessToken,
        isActive:           true,
      },
    });
  }

  async connectManual(scope: TenantScope, data: {
    phoneNumberId: string; whatsappBusinessId: string; accessToken: string;
    phoneNumber?: string; displayName?: string;
  }) {
    return this.prisma.whatsAppIntegration.upsert({
      where:  { phoneNumberId: data.phoneNumberId },
      create: {
        tenantId:           scope.tenantId,
        businessId:         scope.businessId,
        phoneNumberId:      data.phoneNumberId,
        whatsappBusinessId: data.whatsappBusinessId,
        accessToken:        data.accessToken,
        phoneNumber:        data.phoneNumber,
        displayName:        data.displayName,
        isActive:           true,
      },
      update: {
        whatsappBusinessId: data.whatsappBusinessId,
        accessToken:        data.accessToken,
        phoneNumber:        data.phoneNumber,
        displayName:        data.displayName,
        isActive:           true,
      },
    });
  }

  async disconnectIntegration(scope: TenantScope, id: string) {
    await this.getIntegration(scope, id);
    return this.prisma.whatsAppIntegration.update({
      where: { id },
      data:  { accessToken: null, isActive: false },
    });
  }

  async testIntegration(scope: TenantScope, id: string) {
    this.logger.log(`testIntegration start — id=${id} tenantId=${scope.tenantId} businessId=${scope.businessId}`);
    const integration = await this.getIntegration(scope, id);
    this.logger.log(`testIntegration found — phoneNumberId=${integration.phoneNumberId} hasToken=${!!integration.accessToken} isActive=${integration.isActive}`);
    const apiVersion  = process.env.WHATSAPP_API_VERSION ?? 'v20.0';

    const accessToken = decryptSecret(integration.accessToken);
    this.logger.log(`testIntegration decryptSecret — tokenPresent=${!!accessToken} tokenPrefix=${accessToken ? accessToken.slice(0, 6) + '...' : 'null'}`);
    if (!accessToken) {
      return { ok: false, error: 'No access token stored for this integration', phoneNumber: null, qualityRating: null };
    }

    try {
      const url = `https://graph.facebook.com/${apiVersion}/${integration.phoneNumberId}`;
      this.logger.log(`testIntegration → Meta GET ${url}`);
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const json: any = await res.json();
      this.logger.log(`testIntegration ← Meta ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);

      if (!res.ok) {
        // Same rules the send path uses, so a number that fails here fails there with
        // the same sentence rather than two different descriptions of one problem.
        const parsed = parseSendError(res.status, json);
        const rule   = classifySendError(parsed.code, parsed.subcode);
        const errMsg = isKnownSendError(parsed.code, parsed.subcode)
          ? rule.reason
          : (json?.error?.message ?? `Meta ${res.status}`);
        this.logger.warn(`testIntegration Meta error — code=${parsed.code} subcode=${parsed.subcode} msg=${errMsg}`);
        return { ok: false, error: errMsg, phoneNumber: null, qualityRating: null };
      }

      // Refresh snapshot so the settings card shows current Meta data
      await this.prisma.whatsAppIntegration.update({
        where: { id },
        data: {
          ...(json.display_phone_number     && { phoneNumber:            json.display_phone_number }),
          ...(json.verified_name            && { displayName:            json.verified_name }),
          ...(json.quality_rating           && { qualityRating:          json.quality_rating }),
          ...(json.code_verification_status && { codeVerificationStatus: json.code_verification_status }),
        },
      });

      return {
        ok:                     true,
        integrationId:          id,
        phoneNumberId:          integration.phoneNumberId,
        wabaId:                 integration.whatsappBusinessId,
        displayPhoneNumber:     json.display_phone_number          ?? integration.phoneNumber,
        verifiedName:           json.verified_name                 ?? integration.displayName,
        qualityRating:          json.quality_rating                ?? null,
        codeVerificationStatus: json.code_verification_status      ?? null,
      };
    } catch {
      return { ok: false, error: 'Could not reach Meta API', phoneNumber: null, qualityRating: null };
    }
  }

  async getWhatsAppHealth(scope: TenantScope) {
    const integrations = await this.prisma.withRetry(
      () => this.prisma.whatsAppIntegration.findMany({
        where: { tenantId: scope.tenantId, businessId: scope.businessId, isActive: true },
      }),
      'getWhatsAppHealth',
    );

    const apiVersion = process.env.WHATSAPP_API_VERSION ?? 'v20.0';

    return Promise.all(
      integrations.map(async (integration) => {
        try {
          const url = `https://graph.facebook.com/${apiVersion}/${integration.phoneNumberId}`;
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${integration.accessToken}` },
          });

          if (!res.ok) {
            return {
              integrationId: integration.id,
              phoneNumber:   integration.phoneNumber,
              qualityRating: null,
              status:        'ERROR',
            };
          }

          const json: any = await res.json();
          return {
            integrationId: integration.id,
            phoneNumber:   json.display_phone_number ?? integration.phoneNumber,
            qualityRating: json.quality_rating ?? null,
            status:        json.code_verification_status ?? 'UNKNOWN',
          };
        } catch {
          return {
            integrationId: integration.id,
            phoneNumber:   integration.phoneNumber,
            qualityRating: null,
            status:        'ERROR',
          };
        }
      }),
    );
  }

  // ── Team management ────────────────────────────────────────────────────────

  async listTeam(scope: TenantScope) {
    return this.prisma.user.findMany({
      where:   { tenantId: scope.tenantId, role: { not: 'SUPER_ADMIN' as any }, removedAt: null },
      select:  {
        id:           true,
        name:         true,
        email:        true,
        role:         true,
        avatar:       true,
        phone:        true,
        isActive:     true,
        lastLoginAt:  true,
        createdAt:    true,
        aiCreditLimit: true,
        aiCreditsUsed: true,
        _count: { select: { assignedConvs: true, assignedTickets: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Add someone who already has an account to this workspace.
   *
   * Membership is a User row per workspace, so joining means creating one here — reusing
   * the person's existing password hash, never a fresh temp password. That is what makes
   * one login work everywhere: they sign in with the credentials they already have and
   * pick this workspace from the switcher.
   *
   * They must be registered first. Minting an account here is what produced the old
   * two-passwords-per-person problem, where `/auth/workspaces` had to try each one.
   */
  async inviteTeamMember(scope: TenantScope, data: { name?: string; email: string; role?: string }) {
    if (!(TEAM_ADMIN_ROLES as readonly string[]).includes(scope.role)) {
      throw new ForbiddenException('Only the workspace owner or an admin can add team members');
    }

    const email = (data.email ?? '').trim().toLowerCase();
    if (!email) throw new BadRequestException('An email address is required');

    // Refused rather than quietly downgraded. Asking for a role that cannot be handed
    // out used to produce an AGENT, so an owner who meant to add an administrator added
    // an agent instead and had no way of knowing.
    const requested = (data.role ?? 'AGENT').trim().toUpperCase();
    if (!isInvitableRole(requested)) {
      throw new BadRequestException(
        requested === 'SUPER_ADMIN'
          ? 'A super admin runs the platform and cannot be added to a workspace.'
          : requested === 'TENANT_OWNER'
            ? 'A workspace has exactly one owner, so that role cannot be given out.'
            : `"${requested}" is not a role you can assign. Choose one of: ${INVITABLE_ROLES.join(', ')}.`,
      );
    }
    const role = requested;

    // Their account anywhere on the platform — the identity we attach to this workspace.
    const identity = await this.prisma.user.findFirst({
      where:   { email, removedAt: null },
      orderBy: { createdAt: 'asc' },
      select:  { id: true, name: true, password: true, avatar: true, emailVerified: true, tenantId: true },
    });
    if (!identity) {
      const appUrl = process.env['APP_URL'] ?? process.env['FRONTEND_URL'] ?? '';
      throw new ConflictException(
        `No account found for ${email}. Ask them to sign up${appUrl ? ` at ${appUrl}/sign-up` : ''} first, then add them here — they'll use their own password and find this workspace in their workspace switcher.`,
      );
    }

    const existing = await this.prisma.user.findFirst({
      where:  { tenantId: scope.tenantId, email },
      select: { id: true, removedAt: true },
    });

    if (existing && !existing.removedAt) {
      throw new ConflictException('That person is already in this workspace');
    }

    // Re-joining restores the row (and with it their previous permission overrides).
    const member = existing
      ? await this.prisma.user.update({
          where:  { id: existing.id },
          data:   { removedAt: null, isActive: true, role: role as any, ...(data.name ? { name: data.name } : {}) },
          select: { id: true, name: true, email: true, role: true },
        })
      : await this.prisma.user.create({
          data: {
            tenantId:      scope.tenantId,
            name:          data.name?.trim() || identity.name,
            email,
            password:      identity.password,
            avatar:        identity.avatar,
            emailVerified: identity.emailVerified,
            role:          role as any,
          },
          select: { id: true, name: true, email: true, role: true },
        });

    this.permissions.invalidate(member.id);

    // Told, not just added. The address is already a platform account, so this says where
    // to find the new workspace rather than carrying any credential.
    const workspace = await this.prisma.tenant.findUnique({
      where:  { id: scope.tenantId },
      select: { name: true },
    });
    const emailed = await this.mail.send(scope.tenantId, {
      to:      email,
      subject: `You have been added to ${workspace?.name ?? 'a workspace'}`,
      html: inviteEmail({
        name:      member.name ?? email,
        workspace: workspace?.name ?? 'a workspace',
        role:      ROLE_LABELS[role] ?? role,
        rejoined:  Boolean(existing),
        appUrl:    (process.env['APP_URL'] ?? process.env['FRONTEND_URL'] ?? '').split(',')[0].replace(/\/+$/, ''),
      }),
    });

    return { ...member, rejoined: Boolean(existing), usesExistingPassword: true, emailed };
  }

  async updateTeamMember(scope: TenantScope, userId: string, data: {
    name?: string; role?: string; isActive?: boolean; aiCreditLimit?: number | null;
  }) {
    if (!(TEAM_ADMIN_ROLES as readonly string[]).includes(scope.role)) {
      throw new ForbiddenException('Only the workspace owner or an admin can update team members');
    }
    const user = await this.prisma.user.findFirst({
      where:  { id: userId, tenantId: scope.tenantId, removedAt: null },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('User not found');

    // An account has exactly one owner. Without this an admin could PATCH themselves —
    // or anyone — to TENANT_OWNER and take over the workspace.
    if (user.role === 'TENANT_OWNER' && data.role && data.role !== 'TENANT_OWNER') {
      throw new ForbiddenException('The workspace owner\'s role cannot be changed');
    }
    if (data.role !== undefined && !isInvitableRole(data.role)) {
      throw new BadRequestException(`Role must be one of: ${INVITABLE_ROLES.join(', ')}`);
    }
    if (user.role === 'TENANT_OWNER' && data.isActive === false) {
      throw new ForbiddenException('The workspace owner cannot be deactivated');
    }

    const updated = await this.prisma.user.update({
      where:  { id: userId },
      data:   {
        name:     data.name,
        role:     data.role as any,
        isActive: data.isActive,
        ...(data.aiCreditLimit !== undefined ? { aiCreditLimit: data.aiCreditLimit } : {}),
      },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    this.permissions.invalidate(userId);
    return updated;
  }

  /**
   * Revoke someone's membership of this workspace. The row is stamped rather than deleted:
   * `Message.sentById` is nullable, so deleting it would blank "sent by" across every
   * message they ever sent here. They keep their own account and other workspaces.
   */
  async removeTeamMember(scope: TenantScope, userId: string) {
    if (scope.userId === userId) throw new ForbiddenException('You cannot remove yourself');
    if (!(TEAM_ADMIN_ROLES as readonly string[]).includes(scope.role)) {
      throw new ForbiddenException('Only the workspace owner or an admin can remove team members');
    }
    const user = await this.prisma.user.findFirst({
      where:  { id: userId, tenantId: scope.tenantId, removedAt: null },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.role === 'TENANT_OWNER') throw new ForbiddenException('The workspace owner cannot be removed');

    await this.prisma.user.update({
      where: { id: userId },
      data:  { removedAt: new Date(), isActive: false },
    });
    this.permissions.invalidate(userId);
    return { removed: true };
  }

  // ── Team permissions ───────────────────────────────────────────────────────

  /**
   * The permission matrix for one member: the role default, any override, and what is
   * actually in effect.
   *
   * The ceiling comes from the workspace's own account type, read from the database. It
   * used to be read off `scope`, where neither `accountType` nor `resellerType` exists —
   * both were `undefined`, so the ceiling silently fell back to CLIENT and a reseller's
   * team member could never be granted a single reseller permission.
   */
  async getTeamPermissions(scope: TenantScope, memberId: string) {
    if (!(TEAM_ADMIN_ROLES as readonly string[]).includes(scope.role)) {
      throw new ForbiddenException('Only the workspace owner or an admin can view member permissions');
    }
    const member = await this.prisma.user.findFirst({
      where:  { id: memberId, tenantId: scope.tenantId, role: { not: 'SUPER_ADMIN' as any }, removedAt: null },
      select: { id: true, role: true, userPermissions: { select: { permission: true, allowed: true } } },
    });
    if (!member) throw new NotFoundException('Member not found');

    const { accountType, resellerType } = await this.accountKind(scope.tenantId);
    const userOverrides = new Map(member.userPermissions.map(p => [p.permission, p.allowed]));
    const roleOverrides = await this.roleOverrides(accountType, member.role);
    const ceiling = accountCeiling(accountType, resellerType) as readonly string[];
    const principal = { role: member.role, accountType, resellerType };

    const result: Record<string, { roleDefault: boolean; override: boolean | null; effective: boolean }> = {};
    for (const p of PERMISSIONS) {
      if (!ceiling.includes(p)) continue; // outside the ceiling it is not grantable at all
      result[p] = {
        roleDefault: (roleDefaults(member.role) as readonly string[]).includes(p),
        override:    userOverrides.has(p) ? userOverrides.get(p)! : null,
        effective:   resolvePermission(principal, p, roleOverrides, userOverrides),
      };
    }
    return result;
  }

  async updateTeamPermissions(scope: TenantScope, memberId: string, overrides: Record<string, boolean | null>) {
    if (!(TEAM_ADMIN_ROLES as readonly string[]).includes(scope.role)) {
      throw new ForbiddenException('Only the workspace owner or an admin can edit member permissions');
    }
    const member = await this.prisma.user.findFirst({
      where:  { id: memberId, tenantId: scope.tenantId, role: { not: 'SUPER_ADMIN' as any }, removedAt: null },
      select: { id: true, role: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.role === 'TENANT_OWNER') {
      throw new ForbiddenException('The workspace owner always has every permission');
    }

    const { accountType, resellerType } = await this.accountKind(scope.tenantId);
    const validPerms = new Set<string>(PERMISSIONS);
    const ceiling = accountCeiling(accountType, resellerType) as readonly string[];

    await this.prisma.$transaction(async (tx) => {
      for (const [perm, value] of Object.entries(overrides)) {
        if (!validPerms.has(perm)) continue;
        if (value === null) {
          await tx.userPermission.deleteMany({ where: { userId: member.id, permission: perm } });
        } else {
          if (!ceiling.includes(perm)) continue;
          await tx.userPermission.upsert({
            where:  { userId_permission: { userId: member.id, permission: perm } },
            create: { userId: member.id, permission: perm, allowed: value },
            update: { allowed: value },
          });
        }
      }
    });

    // So the change bites on the member's very next request rather than after the cache TTL.
    this.permissions.invalidate(member.id);
    return { success: true };
  }

  /** The workspace's account kind, which sets the permission ceiling. */
  private async accountKind(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { accountType: true, resellerType: true },
    });
    return {
      accountType:  (tenant?.accountType as string | undefined) ?? 'CLIENT',
      resellerType: (tenant?.resellerType as string | null | undefined) ?? null,
    };
  }

  private async roleOverrides(accountType: string, role: string) {
    const rows = await this.prisma.rolePermission.findMany({
      where:  { accountType: accountType as any, role: role as any },
      select: { accountType: true, role: true, permission: true, allowed: true },
    }).catch(() => []);
    return new Map(rows.map(r => [`${r.accountType}:${r.role}:${r.permission}`, r.allowed]));
  }
}
