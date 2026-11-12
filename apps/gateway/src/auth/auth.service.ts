import {
  Injectable, UnauthorizedException, ConflictException, ForbiddenException,
  BadRequestException, Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@lib/prisma';
import { PermissionsService, brandHostWhere, normalizeHost } from '@lib/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import type { RegisterDto } from './dto/register.dto';

export interface JwtPayload {
  sub:        string;
  tenantId:   string;
  businessId: string;
  role:       string;
  email:      string;
}

// Disposable email domains blocklist (partial — extend as needed)
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','tempmail.com','throwaway.email',
  'yopmail.com','sharklasers.com','guerrillamailblock.com','grr.la',
  'guerrillamail.info','guerrillamail.biz','guerrillamail.de','guerrillamail.net',
  'guerrillamail.org','spam4.me','trashmail.com','trashmail.me','trashmail.at',
  'trashmail.io','trashmail.net','dispostable.com','mailnull.com','maildrop.cc',
]);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma:  PrismaService,
    private readonly jwt:     JwtService,
    private readonly cfg:     ConfigService,
    private readonly permissions: PermissionsService,
  ) {}

  // ── Login ──────────────────────────────────────────────────────────────────

  /**
   * Sign in, landing in one workspace.
   *
   * Without a `tenantSlug` the choice is deterministic rather than whatever `findFirst`
   * returned: the workspace the person owns, else their oldest membership. Everything else
   * they belong to is reachable from the in-app switcher, so there is no reason to make
   * them pick before they are even authenticated.
   */
  async validateUser(email: string, password: string, tenantSlug: string) {
    let tenantId: string | undefined;

    if (tenantSlug) {
      const tenant = await this.prisma.tenant.findUnique({
        where:  { slug: tenantSlug },
        select: { id: true, isActive: true },
      });
      if (!tenant?.isActive) throw new UnauthorizedException('Workspace not found');
      tenantId = tenant.id;
    }

    const candidates = await this.prisma.user.findFirst({
      where:   {
        email, isActive: true, removedAt: null,
        tenant: { isActive: true },
        ...(tenantId ? { tenantId } : {}),
      },
      // Their own workspace first (TENANT_OWNER sorts before the rest), then oldest.
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select:  { id: true, email: true, name: true, password: true, role: true, tenantId: true },
    });
    if (!candidates) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, candidates.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return candidates;
  }

  /** Every workspace this person can enter, for the switcher. */
  async listMemberships(email: string, currentTenantId?: string) {
    const rows = await this.prisma.user.findMany({
      where:   { email, isActive: true, removedAt: null, tenant: { isActive: true } },
      select:  {
        id: true, role: true, tenantId: true,
        tenant: { select: { slug: true, name: true, accountType: true, logo: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(r => ({
      tenantId:    r.tenantId,
      tenantSlug:  r.tenant.slug,
      tenantName:  r.tenant.name,
      accountType: r.tenant.accountType as string,
      logo:        r.tenant.logo ?? null,
      role:        r.role as string,
      isOwner:     r.role === 'TENANT_OWNER',
      isCurrent:   r.tenantId === currentTenantId,
    }));
  }

  async listMembershipsForUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { email: true, tenantId: true },
    });
    if (!user) throw new UnauthorizedException('Not authenticated');
    return this.listMemberships(user.email, user.tenantId);
  }

  /**
   * Move an authenticated session into another workspace the same person belongs to.
   * Matched on their email — the identity that spans workspaces — so no password is
   * re-entered and nothing is held in the browser.
   */
  async switchWorkspace(userId: string, tenantId: string) {
    const current = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { email: true },
    });
    if (!current) throw new UnauthorizedException('Not authenticated');

    const target = await this.prisma.user.findFirst({
      where:  { email: current.email, tenantId, isActive: true, removedAt: null, tenant: { isActive: true } },
      select: { id: true, email: true, role: true, tenantId: true },
    });
    if (!target) throw new ForbiddenException('You are not a member of that workspace');

    return this.login(target);
  }

  async login(user: { id: string; email: string; role: string; tenantId: string }) {
    const [business, fullUser] = await Promise.all([
      this.prisma.business.findFirst({
        where:   { tenantId: user.tenantId },
        select:  { id: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.user.findUnique({
        where:  { id: user.id },
        select: {
          id: true, email: true, name: true, role: true, tenantId: true, avatar: true,
          tenant: {
            select: {
              slug: true, name: true, accountType: true,
              resellerType: true, parentId: true,
            },
          },
        },
      }),
    ]);

    const payload: JwtPayload = {
      sub:        user.id,
      tenantId:   user.tenantId,
      businessId: business?.id ?? '',
      role:       user.role,
      email:      user.email,
    };

    return {
      access_token: this.jwt.sign(payload),
      user: {
        id:             fullUser!.id,
        email:          fullUser!.email,
        name:           fullUser!.name,
        role:           fullUser!.role,
        tenantId:       fullUser!.tenantId,
        avatar:         fullUser!.avatar ?? null,
        tenantSlug:     fullUser!.tenant.slug,
        tenantName:     fullUser!.tenant.name,
        accountType:    fullUser!.tenant.accountType,
        resellerType:   fullUser!.tenant.resellerType ?? null,
        parentTenantId: fullUser!.tenant.parentId ?? null,
      },
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: {
        id: true, email: true, name: true, role: true, tenantId: true,
        avatar: true, isActive: true,
        tenant: {
          select: {
            slug: true, name: true, accountType: true,
            resellerType: true, parentId: true, isActive: true,
            subscription: {
              select: {
                plan: {
                  select: {
                    name: true, displayName: true, aiEnabled: true, ragEnabled: true, whiteLabel: true,
                    advancedAi: true, allowExport: true, callingEnabled: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user?.isActive || !user.tenant.isActive) return null;

    const plan = user.tenant.subscription?.plan ?? null;

    // The two things the UI needs to show the right workspace and the right actions in it.
    const [permissions, workspaces] = await Promise.all([
      this.permissions.list(user.id),
      this.listMemberships(user.email, user.tenantId),
    ]);

    return {
      permissions,
      workspaces,
      plan: plan ? {
        name:        plan.name,
        displayName: plan.displayName,
        features: {
          aiEnabled: plan.aiEnabled, ragEnabled: plan.ragEnabled, whiteLabel: plan.whiteLabel,
          advancedAi: plan.advancedAi, allowExport: plan.allowExport, callingEnabled: plan.callingEnabled,
        },
      } : null,
      id:             user.id,
      email:          user.email,
      name:           user.name,
      role:           user.role,
      tenantId:       user.tenantId,
      avatar:         user.avatar ?? null,
      tenantSlug:     user.tenant.slug,
      tenantName:     user.tenant.name,
      accountType:    user.tenant.accountType,
      resellerType:   user.tenant.resellerType ?? null,
      parentTenantId: user.tenant.parentId ?? null,
    };
  }

  // ── Register ───────────────────────────────────────────────────────────────

  async register(dto: RegisterDto, host?: string | null) {
    const domain = dto.email.split('@')[1]?.toLowerCase() ?? '';
    if (DISPOSABLE_DOMAINS.has(domain)) {
      throw new BadRequestException('Disposable email addresses are not allowed');
    }

    // None of these depend on each other, and run one after another they turned a
    // sign-up into five round trips plus a hash before the first row was written. The
    // password hash is deliberately slow and now overlaps the reads rather than following
    // them. Errors are still reported in the order someone would expect to meet them.
    const baseSlug = dto.workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const invite   = dto.inviteCode?.trim() || null;

    const [existingUser, referrer, slug, userInviteCode, starterPlan, hashedPassword] =
      await Promise.all([
        this.prisma.user.findFirst({ where: { email: dto.email } }),
        invite
          ? this.prisma.user.findUnique({ where: { inviteCode: invite } })
          : Promise.resolve(null),
        this.uniqueSlug(baseSlug),
        this.generateInviteCode(),
        this.prisma.plan
          .findFirst({ where: { name: { contains: 'Starter', mode: 'insensitive' } } })
          .catch(() => null),
        bcrypt.hash(dto.password, 12),
      ]);

    if (existingUser) throw new ConflictException('Email already registered');
    if (invite && !referrer) throw new BadRequestException('Invalid invite code');
    const referredByCode: string | null = invite;

    const reseller = await this.resellerFor(host, referrer?.tenantId ?? null);

    const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const { tenant, user } = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: dto.workspaceName,
          slug,
          referredByCode,
          // Who brought them in, as a relation rather than a loose string. Without these
          // two the workspace belonged to nobody: it never appeared in the reseller's
          // panel and never earned them a commission, however they had arrived.
          ...(reseller ? { parentId: reseller, referredById: reseller } : {}),
          accountType: 'CLIENT',
          settings: { create: {} },
        },
      });

      const user = await tx.user.create({
        data: {
          tenantId:      tenant.id,
          name:          dto.name,
          email:         dto.email,
          password:      hashedPassword,
          role:          'TENANT_OWNER',
          inviteCode:    userInviteCode,
          emailVerified: true,
        },
      });

      if (starterPlan) {
        await tx.subscription.create({
          data: {
            tenantId:           tenant.id,
            planId:             starterPlan.id,
            status:             'TRIALING',
            billingCycle:       'MONTHLY',
            currentPeriodStart: new Date(),
            currentPeriodEnd:   trialEnd,
            trialEndsAt:        trialEnd,
          },
        });
      }

      return { tenant, user };
    });

    return this.login(user);
  }

  /**
   * Whose customer this new workspace is.
   *
   * Two ways to arrive, and the stronger one wins. Signing up *on a reseller's own
   * domain* is the clearest statement there is — they are on that reseller's site,
   * looking at that reseller's brand — so the host decides. An invite code decides only
   * when the sign-up came through the platform's own front door.
   *
   * Only a reseller can be a parent. An invite code from an ordinary customer is a
   * referral between customers: it is still recorded on the workspace, but it does not
   * hand their account to somebody else to manage.
   */
  private async resellerFor(host: string | null | undefined, inviterTenantId: string | null): Promise<string | null> {
    const where = brandHostWhere(host, normalizeHost(
      this.cfg.get<string>('PLATFORM_ROOT_DOMAIN') ??
      this.cfg.get<string>('NEXT_PUBLIC_APP_DOMAIN') ??
      (this.cfg.get<string>('NEXTAUTH_URL') ?? ''),
    ));
    if (where) {
      const config = await this.prisma.whiteLabelConfig.findFirst({ where, select: { tenantId: true } });
      if (config) return config.tenantId;
    }

    if (!inviterTenantId) return null;
    const inviter = await this.prisma.tenant.findUnique({
      where:  { id: inviterTenantId },
      select: { id: true, accountType: true, isActive: true },
    });
    return inviter?.accountType === 'RESELLER' && inviter.isActive ? inviter.id : null;
  }

  // ── Forgot password ────────────────────────────────────────────────────────

  async forgotPassword(email: string): Promise<void> {
    // Always return success (anti-enumeration)
    const user = await this.prisma.user.findFirst({
      where:  { email, isActive: true },
      select: { id: true, name: true, tenantId: true },
    });
    if (!user) return;

    const token     = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
      this.prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } }),
    ]);

    const appUrl   = this.cfg.get('FRONTEND_URL', 'http://localhost:3000');
    const resetUrl = `${appUrl}/reset-password?token=${token}`;
    this.logger.log(`Password reset link for ${email}: ${resetUrl}`);
    // TODO: send email via SMTP when email service is configured
  }

  // ── Reset password ─────────────────────────────────────────────────────────

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const record = await this.prisma.passwordResetToken.findUnique({
      where:  { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });

    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // One person, one password — across every workspace they belong to. Membership is a
    // row per workspace sharing an email, so updating only the row that asked for the
    // reset would leave their other workspaces on the old password.
    const owner = await this.prisma.user.findUnique({
      where:  { id: record.userId },
      select: { email: true },
    });

    await this.prisma.$transaction([
      owner
        ? this.prisma.user.updateMany({ where: { email: owner.email }, data: { password: hashedPassword } })
        : this.prisma.user.updateMany({ where: { id: record.userId }, data: { password: hashedPassword } }),
      this.prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
  }

  // ── Verify email ───────────────────────────────────────────────────────────

  async verifyEmail(token: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where:  { emailVerifyToken: token },
      select: { id: true, emailVerified: true, emailVerifyExpiry: true },
    });
    if (!user) throw new BadRequestException('Invalid verification token');
    if (user.emailVerified) return; // already verified
    if (user.emailVerifyExpiry && user.emailVerifyExpiry < new Date()) {
      throw new BadRequestException('Verification token expired');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data:  { emailVerified: true, emailVerifyToken: null, emailVerifyExpiry: null },
    });
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where:  { email, isActive: true },
      select: { id: true, name: true, emailVerified: true },
    });
    if (!user || user.emailVerified) return; // silent success

    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiry      = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await this.prisma.user.update({
      where: { id: user.id },
      data:  { emailVerifyToken: verifyToken, emailVerifyExpiry: expiry },
    });

    const appUrl   = this.cfg.get('FRONTEND_URL', 'http://localhost:3000');
    const verifyUrl = `${appUrl}/verify-email?token=${verifyToken}`;
    this.logger.log(`Verify email link for ${email}: ${verifyUrl}`);
    // TODO: send email via SMTP when email service is configured
  }

  // ── Workspace list (for multi-workspace selector) ─────────────────────────

  async getWorkspaces(email: string, password: string) {
    const users = await this.prisma.user.findMany({
      where:  { email, isActive: true },
      select: {
        id: true, password: true, role: true, tenantId: true,
        tenant: {
          select: { slug: true, name: true, accountType: true, isActive: true },
        },
      },
    });

    if (!users.length) throw new UnauthorizedException('Invalid credentials');

    // Validate password against each record (invited users may have different passwords)
    const workspaces: Array<{
      tenantId: string; tenantSlug: string; tenantName: string;
      accountType: string; role: string; userId: string;
    }> = [];

    for (const u of users) {
      if (!u.tenant.isActive) continue;
      const valid = await bcrypt.compare(password, u.password);
      if (valid) {
        workspaces.push({
          tenantId:    u.tenantId,
          tenantSlug:  u.tenant.slug,
          tenantName:  u.tenant.name,
          accountType: u.tenant.accountType,
          role:        u.role,
          userId:      u.id,
        });
      }
    }

    if (!workspaces.length) throw new UnauthorizedException('Invalid credentials');

    return { workspaces };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async uniqueSlug(base: string): Promise<string> {
    let slug = base;
    let exists = await this.prisma.tenant.findUnique({ where: { slug } });
    while (exists) {
      slug = `${base}-${Date.now()}`;
      exists = await this.prisma.tenant.findUnique({ where: { slug } });
    }
    return slug;
  }

  // ── Service token (Next.js proxy auth) ────────────────────────────────────
  // Next.js API routes call this with the service secret + userId to get a short-lived
  // JWT they can forward to NestJS on behalf of the signed-in NextAuth session user.

  async issueServiceToken(userId: string, email: string, secret: string, requestedBusinessId?: string) {
    const expected = this.cfg.get<string>('SERVICE_SECRET');
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid service secret');
    }

    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { id: true, email: true, role: true, tenantId: true, isActive: true },
    });
    // Fall back to email lookup if id lookup misses (NextAuth may store different id format)
    const resolved = user ?? await this.prisma.user.findFirst({
      where:  { email },
      select: { id: true, email: true, role: true, tenantId: true, isActive: true },
    });
    if (!resolved?.isActive) throw new UnauthorizedException('User not found');

    // Use the requested businessId if provided and it belongs to this tenant; else fall back to first.
    let business: { id: string } | null = null;
    if (requestedBusinessId) {
      business = await this.prisma.business.findFirst({
        where:  { id: requestedBusinessId, tenantId: resolved.tenantId },
        select: { id: true },
      });
    }
    if (!business) {
      business = await this.prisma.business.findFirst({
        where:   { tenantId: resolved.tenantId },
        orderBy: { createdAt: 'asc' },
        select:  { id: true },
      });
    }

    const payload: JwtPayload = {
      sub:        resolved.id,
      tenantId:   resolved.tenantId,
      businessId: business?.id ?? '',
      role:       resolved.role,
      email:      resolved.email,
    };
    return {
      token:     this.jwt.sign(payload, { expiresIn: '1h' }),
      expiresIn: 3600,
    };
  }

  private async generateInviteCode(): Promise<string> {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let attempts = 0; attempts < 10; attempts++) {
      const code = Array.from(crypto.randomBytes(8))
        .map(b => chars[b % chars.length])
        .join('');
      const existing = await this.prisma.user.findUnique({ where: { inviteCode: code } });
      if (!existing) return code;
    }
    throw new Error('Failed to generate unique invite code');
  }
}
