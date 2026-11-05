import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { ClickController } from './click.controller';

@Module({
  imports:     [PrismaModule],
  controllers: [ClickController],
})
export class ClickModule {}
