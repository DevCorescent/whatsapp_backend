import { Logger } from '@nestjs/common';

/**
 * Registers a white-label domain with the hosting project.
 *
 * A CNAME alone is not enough. The app is served by Vercel, which routes by host and
 * answers an unrecognised one with its own 404 — so a reseller can point DNS perfectly
 * and still see nothing. The domain has to be added to the project as well, which is
 * also what issues its certificate.
 *
 * Best-effort by design: a failure here must not stop the branding from saving. The
 * domain is the reseller's record either way, and the result comes back so the screen can
 * say what is left to do rather than claiming success.
 *
 * Without VERCEL_API_TOKEN and VERCEL_PROJECT_ID this reports `manual`, which is the
 * honest answer for a deployment that has not been given the credentials to do it.
 */
export interface DomainAttachResult {
  status: 'added' | 'manual' | 'error';
  message: string;
}

const logger = new Logger('VercelDomains');

/** Where a reseller's CNAME should point. One answer, wherever the app is served from. */
export function cnameTarget(): string {
  return process.env['CNAME_TARGET'] || 'cname.vercel-dns.com';
}

/** Where an apex domain's A record should point, which a CNAME cannot do. */
export function apexTarget(): string {
  return process.env['APEX_IP'] || '76.76.21.21';
}

/**
 * The record a reseller actually has to add, in the words their registrar uses.
 *
 * Every screen said "add a CNAME", for any domain. A domain bought for a brand is
 * usually the bare name — nehacomputers.com — and a CNAME is not allowed at the apex of
 * a zone: registrars refuse it, so the one instruction we gave was impossible to follow
 * for the commonest case. An apex needs an A record instead.
 *
 * The name is what goes in the registrar's form — `@` for the apex, the label alone for
 * a subdomain — rather than the whole domain, which most forms turn into
 * crm.nehacomputers.com.nehacomputers.com.
 */
export function dnsRecordFor(domain: string, rootDomain?: string | null): { type: 'A' | 'CNAME'; name: string; value: string } {
  const host = domain.trim().toLowerCase().replace(/\.$/, '');
  // Two labels is an apex (nehacomputers.com); three or more is a subdomain of it. The
  // multi-part public suffixes (co.uk, com.au) make three labels an apex too.
  const parts = host.split('.');
  const suffixIsTwoPart = /\.(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(host);
  const apexLabels = suffixIsTwoPart ? 3 : 2;

  if (parts.length <= apexLabels) {
    return { type: 'A', name: '@', value: apexTarget() };
  }
  return {
    type: 'CNAME',
    name: parts.slice(0, parts.length - apexLabels).join('.'),
    value: rootDomain ? rootDomain : cnameTarget(),
  };
}

/** The same instruction as a sentence, for places that have no table to draw. */
export function dnsHintFor(domain: string): string {
  const r = dnsRecordFor(domain);
  return r.type === 'A'
    ? `Add an A record for ${domain} (name "@") pointing to ${r.value}.`
    : `Add a CNAME record named "${r.name}" pointing to ${r.value}.`;
}

export interface DomainCheckResult {
  domain: string;
  state: 'connected' | 'pending' | 'not_added' | 'error';
  message: string;
  record: { type: 'A' | 'CNAME'; name: string; value: string };
}

/**
 * Whether a reseller's domain actually reaches the app.
 *
 * "Check now" used to answer `not_added` with a fixed sentence whatever the state of
 * the world, so a reseller who had set DNS correctly hours ago was told, forever, to go
 * and set it. The screen could already draw all four states; nothing ever produced three
 * of them.
 *
 * Two questions, in order, because they fail differently and the fix differs too:
 * does the name resolve to us, and does the app answer on it? DNS right but no answer
 * yet is a certificate still being issued — minutes, not a mistake.
 */
export async function checkDomainHosting(domain: string): Promise<DomainCheckResult> {
  const target = cnameTarget();
  const record = dnsRecordFor(domain);

  // Ask the domain itself first. Comparing DNS answers against the provider's is not a
  // reliable test — Vercel serves *.vercel.app and cname.vercel-dns.com from different
  // anycast pools, so two names that both reach the app resolve to different addresses.
  // Whether the app answers on this host is the question, and it is answerable directly.
  try {
    const res = await fetch(`https://${domain}/api/ping`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'domain-check', 'ngrok-skip-browser-warning': '1' },
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (body?.ok === true) {
      return { domain, state: 'connected', message: `${domain} is live.`, record };
    }
  } catch {
    // Falls through to DNS, which is what says whether this is "not set up" or
    // "set up and not ready yet" — two very different things to be told.
  }

  const dns = await import('node:dns/promises');
  const [cnames, addresses] = await Promise.all([
    dns.resolveCname(domain).catch(() => [] as string[]),
    dns.resolve4(domain).catch(() => [] as string[]),
  ]);
  const resolves = cnames.length > 0 || addresses.length > 0;
  // Judged against the record this domain was told to add: an apex was told to add an
  // A record, so looking only at its CNAMEs would call a correct setup wrong.
  const pointsAtTarget = record.type === 'A'
    ? addresses.includes(record.value)
    : cnames.some((c) => c.replace(/\.$/, '').toLowerCase() === target.toLowerCase());

  if (!resolves) {
    return {
      domain,
      state: 'not_added',
      message: `${domain} does not resolve yet. Add the record below at your DNS provider, then check again.`,
      record,
    };
  }

  if (pointsAtTarget) {
    return {
      domain,
      state: 'pending',
      message: `The record is right and ${domain} is not serving yet — the certificate usually takes a few minutes.`,
      record,
    };
  }

  return {
    domain,
    state: 'pending',
    message: `${domain} resolves, but not to us and it is not serving the app yet. Check the record below matches exactly.`,
    record,
  };
}

export async function attachDomainToHosting(domain: string): Promise<DomainAttachResult> {
  const dnsHint = dnsHintFor(domain);

  // On our own servers there is no registry to add a domain to: the reverse proxy
  // answers for whatever resolves to it and obtains the certificate on first request.
  // DNS really is the whole job there, and saying anything more would send the reseller
  // looking for a step that does not exist.
  if ((process.env['HOSTING_PROVIDER'] ?? 'vercel').toLowerCase() === 'self') {
    return { status: 'added', message: dnsHint };
  }

  const token   = process.env['VERCEL_API_TOKEN'];
  const project = process.env['VERCEL_PROJECT_ID'];

  if (!token || !project) {
    return {
      status: 'manual',
      message: `Add ${domain} to the hosting project. ${dnsHint}`,
    };
  }

  const team = process.env['VERCEL_TEAM_ID']
    ? `?teamId=${encodeURIComponent(process.env['VERCEL_TEAM_ID'])}`
    : '';

  try {
    const res = await fetch(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(project)}/domains${team}`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: domain }),
      },
    );
    const json = await res.json().catch(() => null);

    if (res.ok) {
      logger.log(`Added ${domain} to the hosting project`);
      return { status: 'added', message: `${domain} is registered. ${dnsHint}` };
    }

    // Already there is success as far as the reseller is concerned — the usual cause is
    // saving the branding twice, and reporting it as a failure would be misleading.
    const code = json?.error?.code;
    if (res.status === 409 || code === 'domain_already_in_use') {
      return { status: 'added', message: `${domain} is already registered. ${dnsHint}` };
    }

    const why = json?.error?.message ?? `hosting returned ${res.status}`;
    logger.warn(`Could not add ${domain}: ${why}`);
    return { status: 'error', message: `Saved, but the domain could not be registered: ${why}` };
  } catch (err) {
    logger.error(`Could not reach the hosting API for ${domain}: ${(err as Error).message}`);
    return {
      status: 'error',
      message: `Saved, but the hosting provider could not be reached. ${dnsHint}`,
    };
  }
}
