import {
  Injectable, UnauthorizedException, ConflictException,
  BadRequestException, Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@lib/prisma';
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
  ) {}

  // ── Login ──────────────────────────────────────────────────────────────────

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

    const user = await this.prisma.user.findFirst({
      where:  { email, isActive: true, ...(tenantId ? { tenantId } : {}) },
      select: { id: true, email: true, name: true, password: true, role: true, tenantId: true },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return user;
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
          },
        },
      },
    });

    if (!user?.isActive || !user.tenant.isActive) return null;

    return {
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

  async register(dto: RegisterDto) {
    const domain = dto.email.split('@')[1]?.toLowerCase() ?? '';
    if (DISPOSABLE_DOMAINS.has(domain)) {
      throw new BadRequestException('Disposable email addresses are not allowed');
    }

    // Duplicate email check (across all tenants)
    const existingUser = await this.prisma.user.findFirst({ where: { email: dto.email } });
    if (existingUser) throw new ConflictException('Email already registered');

    // Resolve invite code (referrer)
    let referredByCode: string | null = null;
    if (dto.inviteCode) {
      const referrer = await this.prisma.user.findUnique({ where: { inviteCode: dto.inviteCode } });
      if (!referrer) throw new BadRequestException('Invalid invite code');
      referredByCode = dto.inviteCode;
    }

    // Generate unique tenant slug
    const baseSlug = dto.workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug     = await this.uniqueSlug(baseSlug);

    // Generate unique user invite code
    const userInviteCode = await this.generateInviteCode();

    // Find STARTER plan
    const starterPlan = await this.prisma.plan.findFirst({
      where: { name: { contains: 'Starter', mode: 'insensitive' } },
    }).catch(() => null);

    const hashedPassword = await bcrypt.hash(dto.password, 12);
    const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const { tenant, user } = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: dto.workspaceName,
          slug,
          referredByCode,
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

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { password: hashedPassword } }),
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
