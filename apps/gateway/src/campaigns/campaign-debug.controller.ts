import { Controller, Post, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '@lib/common';
import { CampaignSchedulerService } from './campaign-scheduler.service';

@ApiTags('campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('campaigns')
export class CampaignDebugController {
  constructor(private readonly scheduler: CampaignSchedulerService) {}

  @Post('trigger-scheduled')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually trigger the campaign scheduler (debug)' })
  async triggerScheduled() {
    const result = await this.scheduler.triggerNow();
    return result;
  }

  @Post('queue-health')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check campaign send queue health (debug)' })
  async queueHealth() {
    return this.scheduler.queueHealth();
  }
}
