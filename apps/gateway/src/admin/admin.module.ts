import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports:     [PrismaModule],
  controllers: [AdminController],
  providers:   [AdminService],
})
export class AdminModule {}
