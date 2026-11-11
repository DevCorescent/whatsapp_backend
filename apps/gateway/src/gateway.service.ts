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
  appleIconUrl: true, ogImageUrl: true, themeColor: true,
  accentColor: true, domain: true, supportEmail: true, supportPhone: true, website: true,
  address: true, loginHeadline: true, loginSubtext: true, subdomain: true, landingEnabled: true,
  landingTitle: true, landingSubtitle: true, termsContent: true, privacyContent: true,
} as const;

/** A host reduced to what can be compared: no scheme, no port, no trailing dot. */
function normalizeHost(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/\.$/, '');
}

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

  /**
   * Whether a certificate may be issued for this host.
   *
   * Asked by the reverse proxy, once, the first time a stranger's domain arrives. Serving
   * the platform from one machine means any hostname on earth can be pointed at it, and a
   * proxy that obtained a certificate for each would be an open invitation to exhaust the
   * certificate authority's rate limit on our account — so it asks first, and only a
   * domain a live white-label reseller has actually claimed is allowed.
   *
   * Deliberately plain: 200 for yes, 404 for no, no body worth parsing. That is the whole
   * contract Caddy's `on_demand_tls.ask` expects, and anything cleverer would be a way to
   * fail it.
   */
  async isDomainAllowed(host: string | null | undefined): Promise<boolean> {
    const h = normalizeHost(host);
    if (!h) return false;

    // The platform's own hostnames are served by the same proxy and are not anyone's
    // white-label domain, so they are allowed on their own terms.
    const root = normalizeHost(
      this.cfg.get<string>('PLATFORM_ROOT_DOMAIN') ??
      this.cfg.get<string>('NEXT_PUBLIC_APP_DOMAIN') ??
      (this.cfg.get<string>('NEXTAUTH_URL') ?? ''),
    );
    if (root && (h === root || h.endsWith(`.${root}`))) return true;

    const config = await this.prisma.whiteLabelConfig.findFirst({
      where:  { domain: h, ...LIVE_CONFIG },
      select: { id: true },
    });
    return Boolean(config);
  }

  async getBrandForHost(host: string | null | undefined) {
    if (!host) return null;
    // The same setting the frontend reads, under the same name. These used to be two
    // different variables for one idea, so the two halves could disagree about what
    // counts as a subdomain — and with neither set, every brand host fell through to a
    // domain lookup that could never match a config holding only a subdomain.
    const rootDomain = normalizeHost(
      this.cfg.get<string>('PLATFORM_ROOT_DOMAIN') ??
      this.cfg.get<string>('NEXT_PUBLIC_APP_DOMAIN') ??
      (this.cfg.get<string>('NEXTAUTH_URL') ?? ''),
    );
    const h = normalizeHost(host);
    const sub = rootDomain && h.endsWith(`.${rootDomain}`)
      ? h.slice(0, -(rootDomain.length + 1))
      : null;

    // A host may be claimed either way, so both are tried: a reseller on a subdomain
    // today may point a domain at it tomorrow without the lookup changing.
    return this.prisma.whiteLabelConfig.findFirst({
      where:  { OR: [{ domain: h }, ...(sub ? [{ subdomain: sub }] : [])], ...LIVE_CONFIG },
      select: CONFIG_SELECT,
    });
  }

  /**
   * The homepage content for a host.
   *
   * A white-label brand gets its own sections; anything it has not edited has no row and
   * is filled in from the platform's defaults by the caller, so a new brand reads as the
   * product rather than a blank page. Without a host this is the platform's own site.
   */
  async getPublicCmsSections(host?: string) {
    const brand = host ? await this.getBrandForHost(host) : null;
    const rows = await (this.prisma as any).cmsSection.findMany({
      where:   { tenantId: brand?.tenantId ?? null, page: 'home' },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    return {
      success: true,
      data: rows.map((r: any) => ({
        key:       r.key,
        isActive:  r.isActive,
        content:   r.content,
        itemKinds: r.itemKinds,
        updatedAt: r.updatedAt,
        items:     r.items.map((i: any) => ({
          id:        i.id,
          kind:      i.kind,
          sortOrder: i.sortOrder,
          isActive:  i.isActive,
          data:      i.data,
        })),
      })),
    };
  }
}
