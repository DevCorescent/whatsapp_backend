import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '@lib/prisma';
import { decryptSecret } from '../crypto';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user?: string | null;
  pass?: string | null;
  from: string;
  /** Whose settings these are, for the log line when a send fails. */
  source: string;
}

/**
 * Sends mail as whoever owns the brand the recipient will see.
 *
 * A person invited into a reseller's client account signs in on that reseller's domain,
 * under that reseller's name. An email about it arriving from the platform would name a
 * company they have never heard of, so the reseller's own mail server is used when it has
 * one. The chain is: the account's own settings, then the reseller above it, then the
 * platform's, then the server's environment.
 *
 * Every step is optional. With nothing configured anywhere, `send` reports that it could
 * not deliver rather than throwing — an invitation that cannot be emailed is still a
 * valid invitation, and failing the whole request would be worse than the missing mail.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
  ) {}

  /** The first usable mail configuration above this tenant, or null. */
  async resolve(tenantId: string): Promise<SmtpConfig | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { id: true, name: true, accountType: true, parentId: true },
    });
    if (!tenant) return null;

    // Its own, then the reseller above it when it is a client, then the platform's.
    const chain: { id: string; label: string }[] = [{ id: tenant.id, label: 'this account' }];
    if (tenant.accountType === 'CLIENT' && tenant.parentId) {
      chain.push({ id: tenant.parentId, label: 'its reseller' });
    }
    const platform = await this.prisma.tenant.findFirst({
      where:  { accountType: 'PLATFORM' },
      select: { id: true },
    });
    if (platform && !chain.some((c) => c.id === platform.id)) {
      chain.push({ id: platform.id, label: 'the platform' });
    }

    for (const step of chain) {
      const s = await this.prisma.tenantSettings.findUnique({
        where:  { tenantId: step.id },
        select: { smtpHost: true, smtpPort: true, smtpUser: true, smtpPass: true, smtpFrom: true },
      });
      if (s?.smtpHost && s.smtpFrom) {
        // Stored encrypted. A password that will not decrypt usually means the
        // encryption key changed, and sending with the ciphertext would only produce a
        // confusing authentication failure — so that configuration is skipped and the
        // next one up is tried.
        const pass = s.smtpPass ? decryptSecret(s.smtpPass) : null;
        if (s.smtpUser && !pass) {
          this.logger.warn(`Mail settings for ${step.label} have an unreadable password; skipping`);
          continue;
        }
        return {
          host: s.smtpHost,
          port: s.smtpPort ?? 587,
          user: s.smtpUser,
          pass,
          from: s.smtpFrom,
          source: step.label,
        };
      }
    }

    const host = this.cfg.get<string>('SMTP_HOST');
    const from = this.cfg.get<string>('SMTP_FROM');
    if (host && from) {
      return {
        host,
        port: Number(this.cfg.get<string>('SMTP_PORT') ?? 587),
        user: this.cfg.get<string>('SMTP_USER'),
        pass: this.cfg.get<string>('SMTP_PASS'),
        from,
        source: 'the server configuration',
      };
    }

    return null;
  }

  /**
   * @returns whether the message was handed to a mail server. False means nothing was
   *   configured or the server refused it; the caller decides whether that matters.
   */
  async send(tenantId: string, message: MailMessage): Promise<boolean> {
    const smtp = await this.resolve(tenantId);
    if (!smtp) {
      this.logger.warn(`No mail configuration for tenant ${tenantId}; "${message.subject}" not sent`);
      return false;
    }

    try {
      const transport = nodemailer.createTransport({
        host:   smtp.host,
        port:   smtp.port,
        // 465 is implicit TLS; everything else upgrades with STARTTLS.
        secure: smtp.port === 465,
        ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}),
      });

      await transport.sendMail({
        from:    smtp.from,
        to:      message.to,
        subject: message.subject,
        html:    message.html,
        text:    message.text ?? stripTags(message.html),
      });
      this.logger.log(`Sent "${message.subject}" to ${mask(message.to)} using ${smtp.source}`);
      return true;
    } catch (err: any) {
      // Never the caller's problem: the action that triggered the mail already succeeded.
      this.logger.error(`Could not send "${message.subject}" to ${mask(message.to)}: ${err?.message ?? err}`);
      return false;
    }
  }
}

/** Enough of an address to identify it in a log, without writing it down in full. */
function mask(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return '***';
  return `${name.slice(0, 2)}***@${domain}`;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
