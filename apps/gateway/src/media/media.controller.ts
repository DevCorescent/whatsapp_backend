import {
  Controller, Post, Get, Body, Param, Query, UseGuards, Res,
  UseInterceptors, UploadedFiles, BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { MediaService } from './media.service';

@ApiTags('media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly svc: MediaService) {}

  @Post('upload')
  @ApiOperation({ summary: 'Upload media files (multipart or base64 JSON) to WhatsApp and storage' })
  @ApiConsumes('multipart/form-data', 'application/json')
  @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: 64 * 1024 * 1024 } }))
  uploadMedia(
    @CurrentTenant() scope: TenantScope,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { base64?: string; filename?: string; mimeType?: string },
  ) {
    if (files?.length) return this.svc.uploadFiles(scope, files);
    if (body?.base64) return this.svc.uploadMedia(scope, body as { base64: string; filename: string; mimeType: string });
    return { success: true, data: [] };
  }

  /** The one URL the inbox uses for any attachment: redirects to storage or streams from Meta. */
  @Get('message/:id')
  @ApiOperation({ summary: 'Serve the attachment of a message' })
  async messageMedia(
    @CurrentTenant() scope: TenantScope,
    @Param('id') id: string,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ) {
    const source = await this.svc.sourceForMessage(scope, id);
    if (source.kind === 'redirect') {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.redirect(302, source.url);
      return;
    }
    res.setHeader('Content-Type', source.contentType);
    res.setHeader('Content-Length', String(source.buffer.byteLength));
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (download === '1' && source.filename) {
      res.setHeader('Content-Disposition', `attachment; filename="${source.filename.replace(/["\r\n]/g, '')}"`);
    }
    res.send(source.buffer);
  }

  @Get('whatsapp-proxy')
  @ApiOperation({ summary: 'Proxy WhatsApp media by messageId (preferred) or raw mediaId' })
  async proxyMedia(
    @CurrentTenant() scope: TenantScope,
    @Query('messageId') messageId: string | undefined,
    @Query('mediaId') mediaId: string | undefined,
    @Res() res: Response,
  ) {
    if (messageId) return this.messageMedia(scope, messageId, undefined, res);
    if (!mediaId) throw new BadRequestException('messageId or mediaId is required');
    const { buffer, contentType } = await this.svc.proxyMedia(scope, mediaId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buffer);
  }
}
