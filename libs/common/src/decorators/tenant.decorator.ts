import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export class TenantScope {
  tenantId!:   string;
  businessId!: string;
  userId!:     string;
  role!:       string;
}

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantScope => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as TenantScope;
  },
);
