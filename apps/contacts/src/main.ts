import { NestFactory } from '@nestjs/core';
import { ContactsModule } from './contacts.module';

async function bootstrap() {
  const app = await NestFactory.create(ContactsModule);
  await app.listen(process.env['CONTACTS_PORT'] ?? 4004);
}

bootstrap().catch(console.error);
