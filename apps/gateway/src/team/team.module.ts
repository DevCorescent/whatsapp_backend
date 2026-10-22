import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { SettingsService } from '../settings/settings.service';
import { TeamController } from './team.controller';

@Module({
  imports:     [PrismaModule],
  controllers: [TeamController],
  providers:   [SettingsService],
})
export class TeamModule {}
