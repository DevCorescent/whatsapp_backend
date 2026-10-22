import {
  Controller, Get, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentTenant, TenantScope } from '@lib/common';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  @Get()
  @ApiOperation({ summary: 'Get analytics overview — period=today|7d|30d|90d or from/to dates' })
  getOverview(
    @CurrentTenant() scope: TenantScope,
    @Query('period') period?: string,
    @Query('from')   from?: string,
    @Query('to')     to?: string,
  ) {
    const now = new Date();
    let fromDate: Date;
    let toDate = to ? new Date(to) : now;

    if (period) {
      switch (period) {
        case 'today':  fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
        case '7d':     fromDate = new Date(now.getTime() - 7  * 86400000); break;
        case '30d':    fromDate = new Date(now.getTime() - 30 * 86400000); break;
        case '90d':    fromDate = new Date(now.getTime() - 90 * 86400000); break;
        default:       fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      }
    } else {
      fromDate = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
    }

    return this.svc.getOverview(scope, fromDate, toDate);
  }
}
