import { Injectable } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';

@Injectable()
export class NewsletterService {
  constructor(private readonly prisma: PrismaService) {}

  async subscribe(email: string, source = 'homepage') {
    await this.prisma.newsletterSubscriber.upsert({
      where:  { email },
      create: { email, source },
      update: { source },
    });
    return { success: true };
  }
}
