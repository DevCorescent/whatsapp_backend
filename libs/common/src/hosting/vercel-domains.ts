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

export async function attachDomainToHosting(domain: string): Promise<DomainAttachResult> {
  const token   = process.env['VERCEL_API_TOKEN'];
  const project = process.env['VERCEL_PROJECT_ID'];
  const dnsHint = `Point a CNAME for ${domain} to cname.vercel-dns.com.`;

  if (!token || !project) {
    return {
      status: 'manual',
      message: `Add ${domain} to the hosting project, then ${dnsHint.toLowerCase()}`,
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
