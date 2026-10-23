import { Controller, Post, Body, UseGuards, Logger } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { ConversationsService } from '../../../../apps/messaging/src/conversations/conversations.service';

/**
 * Thin alias so Next.js `POST /api/messages` works with NestJS.
 * Next.js takes `conversationId` in the request body; NestJS natively
 * puts it in the URL as `/conversations/:id/messages`.
 */
@ApiTags('messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('messages')
export class MessagesController {
  private readonly logger = new Logger(MessagesController.name);

  constructor(private readonly svc: ConversationsService) {}

  @Post()
  @ApiOperation({ summary: 'Send a message (body carries conversationId)' })
  send(
    @CurrentTenant() scope: TenantScope,
    @Body() body: {
      conversationId: string;
      type?:          string;
      content?:       string;
      text?:          string;
      isNote?:        boolean;
      interactive?:   Record<string, unknown>;
      replyToId?:     string;
      mediaUrl?:      string;
      mediaId?:       string;
      mediaType?:     string;
      mediaMimeType?: string;
      mediaSize?:     number;
    },
  ) {
    this.logger.log(`POST /messages — conversationId=${body.conversationId} type=${body.type ?? 'TEXT'} tenantId=${scope.tenantId} businessId=${scope.businessId}`);
    const { conversationId, content, ...rest } = body;
    // Next.js sends `content`; the service expects `text`
    const payload = { ...rest, text: rest.text ?? content };
    return this.svc.sendMessage(scope, conversationId, payload);
  }
}
