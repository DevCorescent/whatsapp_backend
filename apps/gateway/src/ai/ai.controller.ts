import {
  Controller, Post, Body, Res, UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { AiService } from './ai.service';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly svc: AiService) {}

  @Post('qualify')
  @ApiOperation({ summary: 'BANT qualification for a conversation or lead' })
  qualify(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { conversationId?: string; leadId?: string },
  ) {
    return this.svc.qualify(scope, body);
  }

  @Post('sentiment')
  @ApiOperation({ summary: 'Sentiment analysis for a conversation' })
  sentiment(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { conversationId: string },
  ) {
    return this.svc.sentiment(scope, body.conversationId);
  }

  @Post('summarize')
  @ApiOperation({ summary: 'Summarize a conversation' })
  summarize(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { conversationId: string },
  ) {
    return this.svc.summarize(scope, body.conversationId);
  }

  /**
   * SSE streaming AI reply — matches Next.js /api/ai/reply exactly.
   * Stream format:
   *   data: {"sources":[...]}   (optional, if RAG context found)
   *   data: {"chunk":"..."}     (repeated per token)
   *   data: [DONE]
   */
  @Post('reply')
  @ApiOperation({ summary: 'Stream an AI reply for a conversation (SSE)' })
  async reply(
    @CurrentTenant() scope: TenantScope,
    @Body() body: { conversationId: string; message?: string },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      await this.svc.replyStream(scope, body.conversationId, body.message, res);
    } catch (err) {
      console.error('[AI] /reply handler error', err);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}
