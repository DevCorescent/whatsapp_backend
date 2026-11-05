import {
  Controller, Get, Post, Delete, Body, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  JwtAuthGuard, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission, requireFields,
} from '@lib/common';
import { CatalogueService } from './catalogue.service';

@ApiTags('catalogue')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequiresPermission('conversations.view')
@Controller('catalogue')
export class CatalogueController {
  constructor(private readonly svc: CatalogueService) {}

  @Get()
  @ApiOperation({ summary: 'Which catalogue each number is connected to' })
  status(@CurrentTenant() scope: TenantScope) {
    return this.svc.status(scope);
  }

  @Get('products')
  @ApiOperation({ summary: 'Products in the connected catalogue' })
  products(
    @CurrentTenant() scope: TenantScope,
    @Query('integrationId') integrationId?: string,
    @Query('search') search?: string,
    @Query('after') after?: string,
  ) {
    return this.svc.products(scope, { integrationId, search, after });
  }

  @Post('connect')
  @RequiresPermission('settings.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Point a number at a Meta Commerce catalogue' })
  connect(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { catalogId?: string; integrationId?: string },
  ) {
    requireFields(body, ['catalogId']);
    return this.svc.connect(scope, body as { catalogId: string; integrationId?: string });
  }

  @Delete('connect')
  @RequiresPermission('settings.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disconnect the catalogue from a number' })
  disconnect(@CurrentTenant() scope: TenantScope, @Query('integrationId') integrationId?: string) {
    return this.svc.disconnect(scope, integrationId);
  }

  @Post('send')
  @RequiresPermission('messages.send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send one or more products into a conversation' })
  send(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { conversationId?: string; retailerIds?: string[]; bodyText?: string; footerText?: string },
  ) {
    requireFields(body, ['conversationId', 'retailerIds']);
    return this.svc.sendProducts(
      scope,
      body as { conversationId: string; retailerIds: string[]; bodyText?: string; footerText?: string },
    );
  }
}
