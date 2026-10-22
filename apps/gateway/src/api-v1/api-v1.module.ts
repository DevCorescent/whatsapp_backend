import { Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { V1Controller } from './v1.controller';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  imports:     [PrismaModule],
  controllers: [V1Controller],
  providers:   [ApiKeyGuard],
})
export class ApiV1Module {}
