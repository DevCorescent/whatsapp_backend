import {
  Injectable, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope } from '@lib/common';

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  private generateInviteCode(length = 8): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // ── Category ───────────────────────────────────────────────────────────────

  async getCategory(scope: TenantScope) {
    const tenant = await this.prisma.tenant.findUnique({
      where:   { id: scope.tenantId },
      include: { category: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return { categoryId: tenant.categoryId, category: tenant.category };
  }

  async setCategory(scope: TenantScope, categoryId: string) {
    const category = await this.prisma.businessCategory.findUnique({
      where: { id: categoryId },
    });
    if (!category) throw new NotFoundException('Category not found');
    if (!category.isActive) throw new BadRequestException('Category is not active');

    const tenant = await this.prisma.tenant.update({
      where:   { id: scope.tenantId },
      data:    { categoryId },
      include: { category: true },
    });
    return { categoryId: tenant.categoryId, category: tenant.category };
  }

  // ── Invite code ────────────────────────────────────────────────────────────

  async getInviteCode(scope: TenantScope) {
    const user = await this.prisma.user.findUnique({
      where:  { id: scope.userId },
      select: { id: true, inviteCode: true },
    });
    if (!user) throw new NotFoundException('User not found');

    if (user.inviteCode) {
      return { inviteCode: user.inviteCode };
    }

    const inviteCode = this.generateInviteCode();
    await this.prisma.user.update({
      where: { id: scope.userId },
      data:  { inviteCode },
    });
    return { inviteCode };
  }
}
