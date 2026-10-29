import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AllowAnyMember, CurrentTenant, HandoverService, JwtAuthGuard, PermissionGuard,
  RequiresPermission, TenantScope,
  DEFAULT_REQUEST_KEYWORDS, HANDOVER_REASON_LABELS, type HandoverReason,
} from '@lib/common';
import { PrismaService } from '@lib/prisma';
import { DepartmentsService } from './departments.service';

const STRATEGIES = ['LEAST_BUSY', 'ROUND_ROBIN', 'DEPARTMENT', 'SPECIFIC_USER'];

@ApiTags('handovers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequiresPermission('conversations.view')
@Controller()
export class HandoverController {
  constructor(
    private readonly handover: HandoverService,
    private readonly departments: DepartmentsService,
    private readonly prisma: PrismaService,
  ) {}

  // ── The queue ──────────────────────────────────────────────────────────────

  @Get('handovers')
  @ApiOperation({ summary: 'Conversations the AI has passed to a person' })
  list(
    @CurrentTenant() scope: TenantScope,
    @Query('status') status?: string,
    @Query('reason') reason?: string,
    @Query('departmentId') departmentId?: string,
    @Query('assignedToId') assignedToId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.handover.list(scope, {
      status, reason, departmentId,
      // "me" saves the client having to know its own id.
      assignedToId: assignedToId === 'me' ? scope.userId : assignedToId,
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('handovers/waiting')
  @ApiOperation({ summary: 'How many handovers are still waiting, for the nav badge' })
  async waiting(@CurrentTenant() scope: TenantScope) {
    return { waiting: await this.handover.waitingCount(scope) };
  }

  @Get('handovers/reasons')
  @AllowAnyMember()
  @ApiOperation({ summary: 'The reasons a handover can happen, with their labels' })
  reasons() {
    return Object.entries(HANDOVER_REASON_LABELS).map(([value, label]) => ({ value, label }));
  }

  @Post('handovers')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Hand a conversation to a person' })
  async create(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { conversationId?: string; note?: string; departmentId?: string; assignToId?: string; reason?: string },
  ) {
    if (!body.conversationId) return { error: 'Which conversation?' };
    // Scoped by hand: the service takes a conversation id and must not accept one from
    // another workspace just because the caller asked for it.
    const conversation = await this.prisma.conversation.findFirst({
      where:  { id: body.conversationId, tenantId: scope.tenantId, businessId: scope.businessId },
      select: { id: true },
    });
    if (!conversation) return { error: 'That conversation does not exist here' };

    const reason = (body.reason && body.reason in HANDOVER_REASON_LABELS ? body.reason : 'MANUAL') as HandoverReason;
    return this.handover.request({
      conversationId: conversation.id,
      reason,
      note:         body.note ?? null,
      departmentId: body.departmentId ?? null,
      assignToId:   body.assignToId ?? null,
      byUserId:     scope.userId,
    });
  }

  @Post('handovers/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take on a handover, making the conversation yours' })
  accept(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.handover.accept({ ...scope, userId: scope.userId }, id);
  }

  @Post('handovers/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a handover dealt with' })
  resolve(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.handover.resolve(scope, id);
  }

  @Post('handovers/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Give the conversation back to the AI' })
  cancel(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.handover.cancel(scope, id);
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  @Get('handovers/settings')
  @RequiresPermission('settings.manage')
  @ApiOperation({ summary: 'When and how conversations are handed to people' })
  async settings(@CurrentTenant() scope: TenantScope) {
    const config = await this.handover.configFor(scope.businessId);
    return {
      // Absent means never configured, so the defaults are what it would do today.
      config: config ?? {
        enabled: true, onCustomerRequest: true, requestKeywords: [],
        onAiUnsure: false, aiUnsureThreshold: 50, afterAiReplies: 0,
        onNegativeSentiment: false, offHours: false,
        strategy: 'LEAST_BUSY', departmentId: null, assignToId: null, onlineOnly: false,
        pauseAi: true, notifyAgent: true, notifyManagers: false,
        customerMessage: null, escalateAfterMinutes: 0,
      },
      defaultKeywords: DEFAULT_REQUEST_KEYWORDS,
      strategies: STRATEGIES,
    };
  }

  @Put('handovers/settings')
  @RequiresPermission('settings.manage')
  @ApiOperation({ summary: 'Save when and how conversations are handed to people' })
  async saveSettings(@CurrentTenant() scope: TenantScope, @Body() body: Record<string, unknown>) {
    const int = (v: unknown, lo: number, hi: number, fallback = lo) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
    };
    const keywords = Array.isArray(body.requestKeywords)
      ? [...new Set((body.requestKeywords as unknown[])
          .map((k) => String(k).trim().toLowerCase())
          .filter((k) => k.length >= 2 && k.length <= 60))].slice(0, 50)
      : undefined;

    // A department or a person named here has to belong to this workspace.
    const departmentId = typeof body.departmentId === 'string' && body.departmentId
      ? (await this.prisma.department.findFirst({
          where: { id: body.departmentId, businessId: scope.businessId }, select: { id: true },
        }))?.id ?? null
      : null;
    const assignToId = typeof body.assignToId === 'string' && body.assignToId
      ? (await this.prisma.user.findFirst({
          where: { id: body.assignToId, tenantId: scope.tenantId, isActive: true, removedAt: null }, select: { id: true },
        }))?.id ?? null
      : null;

    const data = {
      enabled:             body.enabled !== false,
      onCustomerRequest:   body.onCustomerRequest !== false,
      ...(keywords ? { requestKeywords: keywords } : {}),
      onAiUnsure:          body.onAiUnsure === true,
      aiUnsureThreshold:   int(body.aiUnsureThreshold, 0, 100, 50),
      afterAiReplies:      int(body.afterAiReplies, 0, 50, 0),
      onNegativeSentiment: body.onNegativeSentiment === true,
      offHours:            body.offHours === true,
      strategy:            STRATEGIES.includes(String(body.strategy)) ? String(body.strategy) : 'LEAST_BUSY',
      departmentId,
      assignToId,
      onlineOnly:          body.onlineOnly === true,
      pauseAi:             body.pauseAi !== false,
      notifyAgent:         body.notifyAgent !== false,
      notifyManagers:      body.notifyManagers === true,
      customerMessage:     typeof body.customerMessage === 'string' && body.customerMessage.trim()
        ? body.customerMessage.trim().slice(0, 1000) : null,
      escalateAfterMinutes: int(body.escalateAfterMinutes, 0, 1440, 0),
    };

    return this.prisma.handoverConfig.upsert({
      where:  { businessId: scope.businessId },
      create: { tenantId: scope.tenantId, businessId: scope.businessId, ...data, requestKeywords: keywords ?? [] },
      update: data,
    });
  }

  // ── Departments ────────────────────────────────────────────────────────────

  @Get('departments')
  @AllowAnyMember()
  @ApiOperation({ summary: 'Departments a conversation can be handed to' })
  listDepartments(@CurrentTenant() scope: TenantScope) {
    return this.departments.list(scope);
  }

  @Post('departments')
  @RequiresPermission('settings.manage')
  @ApiOperation({ summary: 'Create a department' })
  createDepartment(@CurrentTenant() scope: TenantScope, @Body() body: any) {
    return this.departments.create(scope, body);
  }

  @Patch('departments/:id')
  @RequiresPermission('settings.manage')
  @ApiOperation({ summary: 'Rename a department, or change who is in it' })
  updateDepartment(@CurrentTenant() scope: TenantScope, @Param('id') id: string, @Body() body: any) {
    return this.departments.update(scope, id, body);
  }

  @Delete('departments/:id')
  @RequiresPermission('settings.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a department' })
  removeDepartment(@CurrentTenant() scope: TenantScope, @Param('id') id: string) {
    return this.departments.remove(scope, id);
  }
}
