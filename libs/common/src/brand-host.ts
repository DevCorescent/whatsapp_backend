/**
 * Which white-label reseller a request's host belongs to.
 *
 * The gateway resolved this for branding and nothing else, so sign-up never asked the
 * question — somebody signing up on a reseller's own domain became a direct client of
 * the platform, invisible in the reseller's panel and earning them nothing. Shared
 * rather than copied, because a second copy of this logic would drift the first time
 * subdomains or the root domain changed.
 */

export function normalizeHost(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/\.$/, '');
}

/**
 * Subdomains the platform keeps for itself. A reseller handed `admin` or `api` would
 * take a name the platform answers on, which is a different kind of problem to a clash
 * between two resellers.
 */
export const RESERVED_SUBDOMAINS = new Set([
  'www', 'app', 'admin', 'api', 'mail', 'smtp', 'ftp', 'static', 'cdn', 'assets', 'docs',
  'blog', 'help', 'support', 'status', 'billing', 'dashboard', 'login', 'auth', 'demo',
  'staging', 'dev',
]);

/** A label that may be used as a reseller's subdomain. Mirrors the frontend's rule. */
export function isClaimableSubdomain(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/.test(label)
    && label.length >= 3
    && !RESERVED_SUBDOMAINS.has(label);
}

/** A name reduced to something that can be a subdomain. */
export function subdomainFromName(name: string): string {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return base.length >= 3 ? base : `brand-${base}`.slice(0, 28);
}

/** Only a live white-label reseller claims a host. */
export const LIVE_BRAND_CONFIG = {
  isActive:    true,
  suspendedAt: null,
  tenant: { accountType: 'RESELLER' as const, resellerType: 'WHITE_LABEL' as const, isActive: true },
};

/**
 * The `where` that matches a host, whether the reseller claimed a domain or a subdomain
 * of the platform's own. Both are tried, so a reseller on a subdomain today can point a
 * domain at it tomorrow without anything else changing.
 */
export function brandHostWhere(host: string | null | undefined, rootDomain: string | null | undefined) {
  const h = normalizeHost(host);
  if (!h) return null;
  const root = normalizeHost(rootDomain);
  const sub = root && h.endsWith(`.${root}`) ? h.slice(0, -(root.length + 1)) : null;
  return {
    OR: [{ domain: h }, ...(sub ? [{ subdomain: sub }] : [])],
    ...LIVE_BRAND_CONFIG,
  };
}
