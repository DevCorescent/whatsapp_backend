import {
  Injectable, NotFoundException, ForbiddenException, ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, decryptSecret, encryptSecret, sanitizeWhatsAppToken, isMetaAccessToken } from '@lib/common';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Combined settings (matches Next.js /api/settings GET/PATCH) ──────────────

  async getSettings(scope: TenantScope) {
    const [biz, ts] = await Promise.all([
      this.getBusiness(scope),
      this.prisma.tenantSettings.findUnique({
        where:  { tenantId: scope.tenantId },
        select: { timezone: true, businessHoursStart: true, businessHoursEnd: true, businessDays: true },
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

  async getMessageRates(_scope: TenantScope) {
    const categories = ['WA_MARKETING', 'WA_UTILITY', 'WA_AUTHENTICATION'] as const;
    const rows = await this.prisma.messageRate.findMany({
      where: { resellerId: null },
    });
    return categories.map(category => {
      const row = rows.find(r => r.category === category);
      return { category, priceMinor: row?.priceMinor ?? 0, id: row?.id ?? null };
    });
  }

  async updateMessageRates(
    _scope: TenantScope,
    rates: Array<{ category: string; priceMinor: number }>,
  ) {
    const results = [];
    for (const rate of rates) {
      const existing = await this.prisma.messageRate.findFirst({
        where: { category: rate.category as any, resellerId: null },
      });
      if (existing) {
        results.push(
          await this.prisma.messageRate.update({
            where: { id: existing.id },
            data:  { priceMinor: rate.priceMinor },
          }),
        );
      } else {
        results.push(
          await this.prisma.messageRate.create({
            data: { category: rate.category as any, priceMinor: rate.priceMinor },
          }),
        );
      }
    }
    return results;
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

    const [business, integrations] = await Promise.all([
      this.prisma.business.findFirst({
        where: { id: bizId, tenantId: scope.tenantId },
        select: { id: true, name: true, whatsappPhoneNumberId: true, whatsappAccessToken: true },
      }),
      this.prisma.whatsAppIntegration.findMany({
        where: { tenantId: scope.tenantId, businessId: bizId },
        orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
      }),
    ]);

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
    await this.getIntegration(scope, id); // 404 guard
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
        const errMsg = json?.error?.message ?? `Meta ${res.status}`;
        this.logger.warn(`testIntegration Meta error — code=${json?.error?.code} msg=${errMsg}`);
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
    const integrations = await this.prisma.whatsAppIntegration.findMany({
      where: { tenantId: scope.tenantId, businessId: scope.businessId, isActive: true },
    });

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
      where:   { tenantId: scope.tenantId },
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

  async inviteTeamMember(scope: TenantScope, data: { name: string; email: string; role?: string }) {
    if (!['SUPER_ADMIN', 'TENANT_OWNER', 'OWNER', 'ADMIN'].includes(scope.role)) {
      throw new ForbiddenException('Only OWNER or ADMIN can invite team members');
    }

    const existing = await this.prisma.user.findFirst({
      where: { tenantId: scope.tenantId, email: data.email },
    });
    if (existing) throw new ConflictException('A user with this email already exists in your workspace');

    const bcrypt = await import('bcryptjs');
    const tempPassword = Math.random().toString(36).slice(2, 10);
    const hash = await bcrypt.hash(tempPassword, 12);

    const user = await this.prisma.user.create({
      data: {
        tenantId: scope.tenantId,
        name:     data.name,
        email:    data.email,
        password: hash,
        role:     (data.role ?? 'AGENT') as any,
      },
      select: { id: true, name: true, email: true, role: true },
    });

    // TODO: send invite email in production
    return { ...user, tempPassword, emailSent: false, emailError: 'Email not configured' };
  }

  async updateTeamMember(scope: TenantScope, userId: string, data: {
    name?: string; role?: string; isActive?: boolean;
  }) {
    if (!['SUPER_ADMIN', 'TENANT_OWNER', 'OWNER', 'ADMIN'].includes(scope.role)) {
      throw new ForbiddenException('Only OWNER or ADMIN can update team members');
    }
    const user = await this.prisma.user.findFirst({ where: { id: userId, tenantId: scope.tenantId } });
    if (!user) throw new NotFoundException('User not found');
    return this.prisma.user.update({
      where:  { id: userId },
      data:   { name: data.name, role: data.role as any, isActive: data.isActive },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
  }

  async removeTeamMember(scope: TenantScope, userId: string) {
    if (scope.userId === userId) throw new ForbiddenException('Cannot remove yourself');
    if (!['SUPER_ADMIN', 'TENANT_OWNER', 'OWNER', 'ADMIN'].includes(scope.role)) {
      throw new ForbiddenException('Only OWNER or ADMIN can remove team members');
    }
    const user = await this.prisma.user.findFirst({ where: { id: userId, tenantId: scope.tenantId } });
    if (!user) throw new NotFoundException('User not found');
    await this.prisma.user.delete({ where: { id: userId } });
    return { removed: true };
  }

  // ── Team permissions ───────────────────────────────────────────────────────

  async getTeamPermissions(scope: TenantScope, memberId: string) {
    if (!['SUPER_ADMIN', 'TENANT_OWNER', 'ADMIN'].includes(scope.role)) {
      throw new ForbiddenException('Only owners and admins can view member permissions');
    }
    const member = await this.prisma.user.findFirst({
      where:  { id: memberId, tenantId: scope.tenantId, role: { not: 'SUPER_ADMIN' as any } },
      select: { id: true, role: true, userPermissions: { select: { permission: true, allowed: true } } },
    });
    if (!member) throw new NotFoundException('Member not found');

    const { PERMISSIONS, accountCeiling, roleDefaults } = await import('@lib/common');
    const overrideMap = new Map((member as any).userPermissions.map((p: any) => [p.permission, p.allowed]));
    const ceiling = accountCeiling((scope as any).accountType, (scope as any).resellerType);

    const result: Record<string, { roleDefault: boolean; override: boolean | null; effective: boolean }> = {};
    for (const p of PERMISSIONS) {
      const inCeiling = (ceiling as readonly string[]).includes(p);
      const roleDefault = inCeiling && (roleDefaults(member.role) as readonly string[]).includes(p);
      const override = overrideMap.has(p) ? overrideMap.get(p)! : null;
      const effective = inCeiling ? (override !== null ? (override as boolean) : roleDefault) : false;
      result[p] = { roleDefault, override: override as boolean | null, effective };
    }
    return result;
  }

  async updateTeamPermissions(scope: TenantScope, memberId: string, overrides: Record<string, boolean | null>) {
    if (!['SUPER_ADMIN', 'TENANT_OWNER', 'ADMIN'].includes(scope.role)) {
      throw new ForbiddenException('Only owners and admins can edit member permissions');
    }
    const member = await this.prisma.user.findFirst({
      where:  { id: memberId, tenantId: scope.tenantId, role: { not: 'SUPER_ADMIN' as any } },
      select: { id: true, role: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.role === 'TENANT_OWNER') {
      throw new ForbiddenException('Owner permissions cannot be customized');
    }

    const { PERMISSIONS, accountCeiling } = await import('@lib/common');
    const validPerms = new Set<string>(PERMISSIONS);
    const ceiling = accountCeiling((scope as any).accountType, (scope as any).resellerType);

    await this.prisma.$transaction(async (tx) => {
      for (const [perm, value] of Object.entries(overrides)) {
        if (!validPerms.has(perm)) continue;
        if (value === null) {
          await (tx as any).userPermission.deleteMany({ where: { userId: member.id, permission: perm } });
        } else {
          if (!(ceiling as readonly string[]).includes(perm)) continue;
          await (tx as any).userPermission.upsert({
            where:  { userId_permission: { userId: member.id, permission: perm } },
            create: { userId: member.id, permission: perm, allowed: value },
            update: { allowed: value },
          });
        }
      }
    });
    return { success: true };
  }
}
