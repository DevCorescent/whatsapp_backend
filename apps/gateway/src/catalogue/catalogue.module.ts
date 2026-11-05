import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { CatalogueController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';

@Module({
  imports:     [PrismaModule],
  controllers: [CatalogueController],
  providers:   [CatalogueService],
})
export class CatalogueModule {}
