import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { ExportService } from './export.service';

@ApiTags('export')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('export')
export class ExportController {
  constructor(private readonly svc: ExportService) {}

  @Get()
  @ApiOperation({ summary: 'Export data as CSV — resource or type param accepted' })
  async exportCsv(
    @CurrentTenant() scope: TenantScope,
    @Query('type')     type: string,
    @Query('resource') resource: string,   // Next.js uses ?resource=
    @Query('format')   _format: string,
    @Res() res: Response,
  ) {
    const key = resource ?? type ?? 'contacts';
    const csv = await this.svc.exportCsv(scope, key);
    const filename = `${key}-${Date.now()}.csv`;
    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
}
