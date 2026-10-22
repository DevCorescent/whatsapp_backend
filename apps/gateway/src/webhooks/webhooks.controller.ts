import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly svc: WebhooksService) {}

  // ── API Key (must come before /:id routes) ─────────────────────────────────

  @Get('apikey')
  @ApiOperation({ summary: 'Get current API key' })
  getApiKey(@CurrentTenant() scope: TenantScope) {
    return this.svc.getApiKey(scope);
  }

  @Post('apikey')
  @ApiOperation({ summary: 'Generate a new API key' })
  generateApiKey(@CurrentTenant() scope: TenantScope) {
    return this.svc.generateApiKey(scope);
  }

  @Delete('apikey')
  @ApiOperation({ summary: 'Revoke API key' })
  deleteApiKey(@CurrentTenant() scope: TenantScope) {
    return this.svc.deleteApiKey(scope);
  }

  // ── Webhook Endpoints ──────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List webhook endpoints for the tenant' })
  listEndpoints(@CurrentTenant() scope: TenantScope) {
    return this.svc.listEndpoints(scope);
  }

  @Post()
  @ApiOperation({ summary: 'Create a webhook endpoint' })
  createEndpoint(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { url: string; events: string[]; description?: string },
  ) {
    return this.svc.createEndpoint(scope, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a webhook endpoint' })
  updateEndpoint(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { url?: string; events?: string[]; isActive?: boolean; description?: string },
  ) {
    return this.svc.updateEndpoint(scope, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a webhook endpoint' })
  deleteEndpoint(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.deleteEndpoint(scope, id);
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'List recent deliveries for a webhook endpoint' })
  listDeliveries(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.listDeliveries(scope, id);
  }
}
