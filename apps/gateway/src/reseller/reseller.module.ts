import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { ResellerController } from './reseller.controller';
import { ResellerService } from './reseller.service';

@Module({
  imports:     [PrismaModule],
  controllers: [ResellerController],
  providers:   [ResellerService],
})
export class ResellerModule {}
