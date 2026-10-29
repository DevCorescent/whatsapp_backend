import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsService } from '../permissions/permissions.service';
import type { Permission } from '../permissions';

const PERMISSION_KEY = 'requiredPermission';

/**
 * Refuse the route unless the caller holds this permission. Put it on the handler for a
 * specific action, or on the controller as the default for every route in it — the
 * handler wins. Use after JwtAuthGuard.
 */
export const RequiresPermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

/**
 * Opt one route out of its controller's class-level requirement — for things every member
 * of a workspace needs regardless of role, like listing the businesses they can switch
 * between. Null is still "defined" to the reflector, so it overrides the class value.
 */
export const AllowAnyMember = () => SetMetadata(PERMISSION_KEY, null);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector:   Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!permission) return true;

    const userId: string | undefined = ctx.switchToHttp().getRequest().user?.userId;
    if (!userId) throw new ForbiddenException('Not authenticated');

    if (await this.permissions.can(userId, permission)) return true;

    // Same structured shape as PlanFeatureGuard so the client can tell a permission
    // refusal from an ordinary error and hide the action rather than retry it.
    throw new ForbiddenException({
      success:    false,
      error:      "You don't have permission to do that in this workspace.",
      code:       'PERMISSION_DENIED',
      permission,
    });
  }
}
