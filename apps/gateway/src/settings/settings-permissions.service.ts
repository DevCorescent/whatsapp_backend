import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, TEAM_ADMIN_ROLES, PermissionsService } from '@lib/common';

@Injectable()
export class SettingsPermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  async getPermissions(scope: TenantScope, userId: string) {
    // Validate the user belongs to the same tenant
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: scope.tenantId, removedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found in this workspace');

    return this.prisma.userPermission.findMany({
      where:   { userId },
      orderBy: { permission: 'asc' },
    });
  }

  async setPermissions(
    scope: TenantScope,
    userId: string,
    permissions: { permission: string; allowed: boolean }[],
  ) {
    // Was ['OWNER','ADMIN'] — 'OWNER' is not a UserRole, so the real workspace owner
    // (TENANT_OWNER) was refused here while only ADMIN could ever pass.
    if (!(TEAM_ADMIN_ROLES as readonly string[]).includes(scope.role)) {
      throw new ForbiddenException('Only the workspace owner or an admin can set permissions');
    }

    // Validate the target user belongs to the same tenant
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: scope.tenantId, removedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found in this workspace');

    // Upsert each permission
    const results = await Promise.all(
      permissions.map((p) =>
        this.prisma.userPermission.upsert({
          where:  { userId_permission: { userId, permission: p.permission } },
          create: { userId, permission: p.permission, allowed: p.allowed },
          update: { allowed: p.allowed },
        }),
      ),
    );

    this.permissions.invalidate(userId);
    return results;
  }
}
