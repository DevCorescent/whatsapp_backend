import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { GatewayWebhookModule } from '../webhook/webhook.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports:     [PrismaModule, GatewayWebhookModule],
  controllers: [LeadsController],
  providers:   [LeadsService],
})
export class LeadsModule {}
