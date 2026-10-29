import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { PERMISSIONS, resolvePermission, type Permission } from '../permissions';

const CACHE_TTL_MS = 60_000;

export interface PermissionPrincipal {
  userId:       string;
  role:         string;
  tenantId:     string;
  accountType:  string;
  resellerType: string | null;
}

/**
 * What one member may actually do, resolved from the database.
 *
 * `accountType` and `resellerType` are deliberately loaded here rather than read off the
 * request: they are not in the JWT, and callers that assumed they were have been silently
 * resolving every permission against the CLIENT ceiling — which is why a reseller's team
 * member could never be granted a reseller permission.
 */
@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);
  private readonly cache = new Map<string, { permissions: Set<string>; principal: PermissionPrincipal | null; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async effectiveFor(userId: string): Promise<Set<string>> {
    return (await this.load(userId)).permissions;
  }

  async can(userId: string, permission: Permission): Promise<boolean> {
    return (await this.effectiveFor(userId)).has(permission);
  }

  /** Sorted list for /auth/me, so the UI can gate on exactly what the server will allow. */
  async list(userId: string): Promise<string[]> {
    return [...(await this.effectiveFor(userId))].sort();
  }

  async principalFor(userId: string): Promise<PermissionPrincipal | null> {
    return (await this.load(userId)).principal;
  }

  invalidate(userId?: string) {
    if (userId) this.cache.delete(userId);
    else this.cache.clear();
  }

  private async load(userId: string) {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: {
        id: true, role: true, tenantId: true, isActive: true,
        tenant: { select: { accountType: true, resellerType: true, isActive: true } },
        userPermissions: { select: { permission: true, allowed: true } },
      },
    });

    let principal: PermissionPrincipal | null = null;
    let permissions = new Set<string>();

    if (user && user.isActive && user.tenant.isActive) {
      principal = {
        userId:       user.id,
        role:         user.role,
        tenantId:     user.tenantId,
        accountType:  user.tenant.accountType,
        resellerType: user.tenant.resellerType ?? null,
      };

      const roleRows = await this.prisma.rolePermission.findMany({
        where:  { accountType: user.tenant.accountType, role: user.role },
        select: { accountType: true, role: true, permission: true, allowed: true },
      }).catch(() => []);

      const roleOverrides = new Map(roleRows.map(r => [`${r.accountType}:${r.role}:${r.permission}`, r.allowed]));
      const userOverrides = new Map(user.userPermissions.map(p => [p.permission, p.allowed]));

      permissions = new Set(
        PERMISSIONS.filter(p => resolvePermission(principal, p, roleOverrides, userOverrides)),
      );
    }

    const entry = { permissions, principal, expiresAt: Date.now() + CACHE_TTL_MS };
    this.cache.set(userId, entry);
    return entry;
  }
}
