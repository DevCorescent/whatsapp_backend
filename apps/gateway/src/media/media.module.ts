import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@lib/prisma';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports:     [PrismaModule, ConfigModule],
  controllers: [MediaController],
  providers:   [MediaService],
})
export class MediaModule {}
