import { IsString, MinLength, Matches } from 'class-validator';

export class ResetPasswordDto {
  @IsString() @MinLength(10)
  token: string;

  @IsString() @MinLength(8)
  @Matches(/(?=.*[A-Z])(?=.*\d)/, { message: 'Password must contain at least one uppercase letter and one number' })
  password: string;
}
