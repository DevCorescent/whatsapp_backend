import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@lib/prisma';
import { GatewayBillingController } from './billing.controller';
import { BillingService } from '../../../../apps/billing/src/billing.service';

@Module({
  imports:     [PrismaModule, ConfigModule],
  controllers: [GatewayBillingController],
  providers:   [BillingService],
})
export class GatewayBillingModule {}
