import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { ContactsController } from '../../../../apps/contacts/src/contacts.controller';
import { ContactsService }    from '../../../../apps/contacts/src/contacts.service';
import { TagsController }     from '../../../../apps/contacts/src/tags/tags.controller';

@Module({
  imports:     [PrismaModule],
  controllers: [ContactsController, TagsController],
  providers:   [ContactsService],
})
export class ContactsModule {}
