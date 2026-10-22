import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { BillingService } from '../../../../apps/billing/src/billing.service';
import { WalletController } from './wallet.controller';

@Module({
  imports:     [PrismaModule],
  controllers: [WalletController],
  providers:   [BillingService],
})
export class WalletModule {}
