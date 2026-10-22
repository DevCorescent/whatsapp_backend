import { IsEmail, IsString, IsOptional, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'admin@workspace.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ example: 'my-workspace', description: 'Tenant slug (optional — omit to match by email across all tenants)' })
  @IsOptional()
  @IsString()
  tenantSlug?: string;
}
