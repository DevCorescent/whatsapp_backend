import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope, PermissionGuard, RequiresPermission } from '@lib/common';
import { ExportService } from './export.service';

@ApiTags('export')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequiresPermission('contacts.export')
@Controller('export')
export class ExportController {
  constructor(private readonly svc: ExportService) {}

  @Get()
  @ApiOperation({ summary: 'Export data as CSV, or as rows with ?format=json' })
  async exportCsv(
    @CurrentTenant() scope: TenantScope,
    @Query('type')     type: string,
    @Query('resource') resource: string,   // Next.js uses ?resource=
    @Query('format')   format: string,
    @Res() res: Response,
  ) {
    const key = resource ?? type ?? 'contacts';

    // `format` was accepted and ignored. The printable view needs the same rows as the
    // CSV, not a file to download, so it asks for them here rather than parsing a CSV
    // back apart on the client — where the phone column, deliberately written as a
    // spreadsheet formula, would have to be taken apart again.
    if (format === 'json') {
      const data = await this.svc.exportRows(scope, key);
      res.json({ success: true, data });
      return;
    }

    const csv = await this.svc.exportCsv(scope, key);
    const filename = `${key}-${Date.now()}.csv`;
    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
}
