import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  imports:     [PrismaModule],
  controllers: [AccountController],
  providers:   [AccountService],
})
export class AccountModule {}
