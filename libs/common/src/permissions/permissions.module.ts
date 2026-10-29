import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@lib/prisma';
import { PermissionsService } from './permissions.service';
import { PermissionGuard } from '../guards/permission.guard';

@Global()
@Module({
  imports:   [PrismaModule],
  providers: [PermissionsService, PermissionGuard],
  exports:   [PermissionsService, PermissionGuard],
})
export class PermissionsModule {}
