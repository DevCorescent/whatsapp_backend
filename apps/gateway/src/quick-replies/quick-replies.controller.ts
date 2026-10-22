import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { QuickRepliesService } from './quick-replies.service';

@ApiTags('quick-replies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('quick-replies')
export class QuickRepliesController {
  constructor(private readonly svc: QuickRepliesService) {}

  @Get()
  @ApiOperation({ summary: 'List quick replies for business' })
  list(
    @CurrentTenant() scope: TenantScope,
    @Query('search') search?: string,
  ) {
    return this.svc.list(scope, { search });
  }

  @Post()
  @ApiOperation({ summary: 'Create a quick reply' })
  create(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { shortcode: string; content: string },
  ) {
    return this.svc.create(scope, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a quick reply' })
  update(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: { shortcode?: string; content?: string },
  ) {
    return this.svc.update(scope, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a quick reply' })
  remove(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.svc.remove(scope, id);
  }
}
