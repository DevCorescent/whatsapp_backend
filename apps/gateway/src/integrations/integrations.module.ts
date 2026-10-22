import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { SettingsService } from '../settings/settings.service';
import { IntegrationsController } from './integrations.controller';

@Module({
  imports:     [PrismaModule],
  controllers: [IntegrationsController],
  providers:   [SettingsService],
})
export class IntegrationsModule {}
