import {
  Controller, Post, Get, Body, Query, UseGuards, Res,
  UseInterceptors, UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { MediaService } from './media.service';

@ApiTags('media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly svc: MediaService) {}

  @Post('upload')
  @ApiOperation({ summary: 'Upload media files (multipart or base64 JSON)' })
  @ApiConsumes('multipart/form-data', 'application/json')
  @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: 64 * 1024 * 1024 } }))
  uploadMedia(
    @CurrentTenant() scope: TenantScope,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { base64?: string; filename?: string; mimeType?: string },
  ) {
    if (files?.length) {
      return this.svc.uploadFiles(scope, files);
    }
    if (body?.base64) {
      return this.svc.uploadMedia(scope, body as { base64: string; filename: string; mimeType: string });
    }
    return { success: true, data: [] };
  }

  @Get('whatsapp-proxy')
  @ApiOperation({ summary: 'Proxy WhatsApp media by mediaId' })
  async proxyMedia(
    @CurrentTenant() scope: TenantScope,
    @Query('mediaId') mediaId: string,
    @Res() res: any,
  ) {
    const { buffer, contentType } = await this.svc.proxyMedia(scope, mediaId);
    res.setHeader('Content-Type', contentType);
    res.send(buffer);
  }

  @Get('serve')
  @ApiOperation({ summary: 'Placeholder for file serving (use S3 presigned URLs)' })
  serveMedia() {
    return this.svc.serveMedia();
  }
}
