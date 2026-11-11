import { IsEmail, IsOptional, IsString, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsString() @MinLength(2) @MaxLength(100)
  name: string;

  @IsEmail()
  email: string;

  @IsString() @MinLength(8) @MaxLength(100)
  password: string;

  @IsString() @MinLength(2) @MaxLength(100)
  workspaceName: string;

  /**
   * Optional, and it has to say so.
   *
   * Without `@IsOptional()` the rules below ran against an absent field and the sign-up
   * was refused with "inviteCode must be shorter than or equal to 20 characters" — for a
   * box the form itself labels optional and the person had left empty. The form also
   * sends "" when it is blank, which is why that is allowed through to mean "none".
   */
  @IsOptional() @IsString() @MaxLength(20)
  inviteCode?: string;
}
