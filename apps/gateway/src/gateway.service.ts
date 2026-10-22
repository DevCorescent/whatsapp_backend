import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@lib/prisma';

const LIVE_CONFIG = {
  isActive:    true,
  suspendedAt: null,
  tenant: { accountType: 'RESELLER' as const, resellerType: 'WHITE_LABEL' as const, isActive: true },
};

const CONFIG_SELECT = {
  tenantId: true, brandName: true, logoUrl: true, faviconUrl: true, primaryColor: true,
  accentColor: true, domain: true, supportEmail: true, supportPhone: true, website: true,
  address: true, loginHeadline: true, loginSubtext: true, subdomain: true, landingEnabled: true,
  landingTitle: true, landingSubtitle: true, termsContent: true, privacyContent: true,
} as const;

@Injectable()
export class GatewayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg:   ConfigService,
  ) {}

  async getPlanName(tenantId: string): Promise<string | null> {
    try {
      const sub = await this.prisma.subscription.findUnique({
        where:  { tenantId },
        select: { plan: { select: { displayName: true, name: true } } },
      });
      return sub?.plan?.displayName ?? sub?.plan?.name ?? null;
    } catch {
      return null;
    }
  }

  async getBrandForTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { accountType: true, parentId: true },
    });
    const brandOwner =
      tenant?.accountType === 'RESELLER' ? tenantId :
      tenant?.accountType === 'CLIENT'   ? tenant.parentId : null;
    if (!brandOwner) return null;

    return this.prisma.whiteLabelConfig.findFirst({
      where:  { tenantId: brandOwner, ...LIVE_CONFIG },
      select: CONFIG_SELECT,
    });
  }

  async getBrandForHost(host: string | null | undefined) {
    if (!host) return null;
    const rootDomain =
      this.cfg.get<string>('NEXT_PUBLIC_APP_DOMAIN') ??
      (this.cfg.get<string>('NEXTAUTH_URL') ?? '').replace(/^https?:\/\//, '').split('/')[0];
    const sub = rootDomain && host.endsWith(`.${rootDomain}`)
      ? host.slice(0, -(rootDomain.length + 1))
      : null;

    return this.prisma.whiteLabelConfig.findFirst({
      where:  { ...(sub ? { subdomain: sub } : { domain: host }), ...LIVE_CONFIG },
      select: CONFIG_SELECT,
    });
  }
}
