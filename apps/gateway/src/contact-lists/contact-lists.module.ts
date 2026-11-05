import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { ContactListsController } from './contact-lists.controller';
import { ContactListsService } from './contact-lists.service';

@Module({
  imports:     [PrismaModule],
  controllers: [ContactListsController],
  providers:   [ContactListsService],
  // Campaigns resolve a list into its recipients when one is used as an audience.
  exports:     [ContactListsService],
})
export class ContactListsModule {}
