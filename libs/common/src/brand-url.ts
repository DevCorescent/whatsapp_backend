import type { PrismaService } from '@lib/prisma';
import { normalizeHost } from './brand-host';

/**
 * The web address a person of this tenant actually uses.
 *
 * Every link we put in an email was built from FRONTEND_URL — the platform's own
 * address — whoever it was going to. A reseller's client who asked to reset their
 * password on crm.acme.com received a link to the platform's domain, landed on a page
 * carrying somebody else's name, and that is the whole white-label illusion gone in one
 * email. FRONTEND_URL can also hold a comma-separated list, which produced a link that
 * was not a URL at all.
 *
 * The brand owner is the reseller: a client of one has no configuration of its own, so
 * the question is asked of its parent — the same rule the branding lookup uses.
 */
export function platformUrl(): string {
  const raw = process.env['APP_URL'] ?? process.env['FRONTEND_URL'] ?? 'http://localhost:3000';
  return raw.split(',')[0].trim().replace(/\/+$/, '');
}

export async function tenantBaseUrl(prisma: PrismaService, tenantId: string | null | undefined): Promise<string> {
  const fallback = platformUrl();
  if (!tenantId) return fallback;

  try {
    const tenant = await prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { accountType: true, parentId: true },
    });
    const owner =
      tenant?.accountType === 'RESELLER' ? tenantId :
      tenant?.accountType === 'CLIENT'   ? tenant.parentId : null;
    if (!owner) return fallback;

    const config = await prisma.whiteLabelConfig.findFirst({
      where:  {
        tenantId: owner,
        isActive: true,
        suspendedAt: null,
        tenant: { accountType: 'RESELLER', resellerType: 'WHITE_LABEL', isActive: true },
      },
      select: { domain: true, subdomain: true },
    });
    if (!config) return fallback;

    if (config.domain) return `https://${normalizeHost(config.domain)}`;

    const root = normalizeHost(process.env['PLATFORM_ROOT_DOMAIN']);
    if (config.subdomain && root) return `https://${config.subdomain}.${root}`;

    return fallback;
  } catch {
    // A link to the platform is wrong for a reseller's customer, but no link at all is
    // worse for everyone, so a lookup that fails still produces a working address.
    return fallback;
  }
}
