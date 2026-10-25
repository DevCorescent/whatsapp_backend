import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';
import { TenantScope, WebhookDispatchService } from '@lib/common';
import * as crypto from 'crypto';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: WebhookDispatchService,
  ) {}

  /** Fire an event to all active webhook endpoints for the tenant. */
  dispatchEvent(tenantId: string, event: string, data: Record<string, unknown>) {
    return this.dispatcher.dispatchEvent(tenantId, event, data);
  }

  // ── Webhook Endpoints ──────────────────────────────────────────────────────

  async listEndpoints(scope: TenantScope) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where:   { tenantId: scope.tenantId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { deliveries: true } } },
    });
    // Return `endpoints` key to match Next.js /api/webhooks shape
    return { success: true, endpoints };
  }

  async createEndpoint(scope: TenantScope, data: { url: string; events: string[]; description?: string }) {
    const secret = crypto.randomBytes(24).toString('hex');
    return this.prisma.webhookEndpoint.create({
      data: {
        tenantId:    scope.tenantId,
        url:         data.url,
        events:      data.events,
        secret,
        isActive:    true,
        description: data.description ?? null,
      },
    });
  }

  async updateEndpoint(scope: TenantScope, id: string, data: { url?: string; events?: string[]; isActive?: boolean; description?: string }) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    if (endpoint.tenantId !== scope.tenantId) throw new ForbiddenException('Access denied');
    return this.prisma.webhookEndpoint.update({ where: { id }, data: data as any });
  }

  async deleteEndpoint(scope: TenantScope, id: string) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    if (endpoint.tenantId !== scope.tenantId) throw new ForbiddenException('Access denied');
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    return { success: true };
  }

  async listDeliveries(scope: TenantScope, endpointId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    if (endpoint.tenantId !== scope.tenantId) throw new ForbiddenException('Access denied');
    return this.prisma.webhookDelivery.findMany({
      where:   { endpointId },
      orderBy: { createdAt: 'desc' },
      take:    50,
    });
  }

  // ── API Key ────────────────────────────────────────────────────────────────

  async getApiKey(scope: TenantScope) {
    const settings = await this.prisma.tenantSettings.findUnique({ where: { tenantId: scope.tenantId } });
    const key = settings?.apiKey ?? null;
    // Return success:true so TransformInterceptor passes through without double-wrapping
    return {
      success:   true,
      hasKey:    !!key,
      maskedKey: key ? `${'•'.repeat(Math.max(0, key.length - 8))}${key.slice(-8)}` : null,
    };
  }

  async generateApiKey(scope: TenantScope) {
    const apiKey = crypto.randomBytes(32).toString('hex');
    await this.prisma.tenantSettings.upsert({
      where:  { tenantId: scope.tenantId },
      create: { tenantId: scope.tenantId, apiKey },
      update: { apiKey },
    });
    // success:true → TransformInterceptor passthrough; apiKey at top level for frontend
    return { success: true, apiKey };
  }

  async deleteApiKey(scope: TenantScope) {
    await this.prisma.tenantSettings.upsert({
      where:  { tenantId: scope.tenantId },
      create: { tenantId: scope.tenantId, apiKey: null },
      update: { apiKey: null },
    });
    return { success: true };
  }
}
