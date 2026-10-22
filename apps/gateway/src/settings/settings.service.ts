import {
  Injectable, NotFoundException, ForbiddenException, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Combined settings (matches Next.js /api/settings GET/PATCH) ──────────────

  async getSettings(scope: TenantScope) {
    const biz = await this.getBusiness(scope);
    return {
      name:            biz.name,
      timezone:        (biz as any).timezone,
      logo:            (biz as any).logoUrl,
      autoReply:       (biz as any).autoReply,
      autoReplyDelay:  (biz as any).autoReplyDelay,
      offHoursMessage: (biz as any).offHoursMessage,
      aiEnabled:       (biz as any).aiEnabled,
      aiModel:         (biz as any).aiModel,
      aiSystemPrompt:  (biz as any).aiSystemPrompt,
      aiPersonality:   (biz as any).aiPersonality,
      aiResponseTone:  (biz as any).aiResponseTone,
      aiTemperature:   (biz as any).aiTemperature,
      aiMaxTokens:     (biz as any).aiMaxTokens,
    };
  }

  async updateSettings(scope: TenantScope, data: Record<string, unknown>) {
    await this.getBusiness(scope);
    return this.prisma.business.update({ where: { id: scope.businessId }, data: data as any });
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
    return this.prisma.business.update({
      where: { id: scope.businessId },
      data:  {
        aiEnabled:       data.aiEnabled,
        aiModel:         data.aiModel,
        aiSystemPrompt:  data.aiSystemPrompt,
        aiInstructions:  data.aiInstructions as any,
        aiPersonality:   data.aiPersonality,
        aiResponseTone:  data.aiResponseTone,
        aiTemperature:   data.aiTemperature,
        aiMaxTokens:     data.aiMaxTokens,
        autoReply:       data.autoReply,
        autoReplyDelay:  data.autoReplyDelay,
        offHoursMessage: data.offHoursMessage,
      },
    });
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
    const integration = await this.getIntegration(scope, id);
    const apiVersion  = process.env.WHATSAPP_API_VERSION ?? 'v20.0';

    try {
      const url = `https://graph.facebook.com/${apiVersion}/${integration.phoneNumberId}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${integration.accessToken}` },
      });

      if (!res.ok) {
        return { ok: false, phoneNumber: null, qualityRating: null };
      }

      const json: any = await res.json();
      return {
        ok:            true,
        phoneNumber:   json.display_phone_number ?? integration.phoneNumber,
        qualityRating: json.quality_rating ?? null,
      };
    } catch {
      return { ok: false, phoneNumber: null, qualityRating: null };
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
    if (!['OWNER', 'ADMIN'].includes(scope.role)) {
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
    if (!['OWNER', 'ADMIN'].includes(scope.role)) {
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
    if (!['OWNER', 'ADMIN'].includes(scope.role)) {
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
