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
