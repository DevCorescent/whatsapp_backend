import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports:     [PrismaModule],
  controllers: [SearchController],
  providers:   [SearchService],
})
export class SearchModule {}
