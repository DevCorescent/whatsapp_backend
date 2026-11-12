import {
  Controller, Post, Get, Body, Query, UseGuards,
  HttpCode, HttpStatus, Request, NotFoundException, Headers,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, requireFields,} from '@lib/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @UseGuards(AuthGuard('local'))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email + password + tenantSlug' })
  async login(@Body() _dto: LoginDto, @Request() req: any) {
    return this.authService.login(req.user);
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new workspace and owner account' })
  register(@Body() dto: RegisterDto, @Headers('x-brand-host') host?: string) {
    // Which front door they came through. A reseller's own domain says whose customer
    // this is far more plainly than any code typed into a box.
    return this.authService.register(dto, host);
  }

  @Post('workspaces')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List all workspaces for a set of credentials (multi-workspace selector)' })
  async workspaces(@Body() body: { email: string; password: string }) {
    requireFields(body, ['email', 'password']);
    return this.authService.getWorkspaces(body.email, body.password);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send password reset email' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);
    return { message: 'If an account exists, a reset link has been sent' };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using token from email' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.password);
    return { message: 'Password reset successfully' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get current authenticated user profile' })
  async me(@Request() req: any) {
    const profile = await this.authService.me(req.user.userId);
    if (!profile) throw new NotFoundException('User not found or deactivated');
    return profile;
  }

  @Get('workspaces/mine')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Workspaces the signed-in person belongs to' })
  myWorkspaces(@Request() req: any) {
    return this.authService.listMembershipsForUser(req.user.userId);
  }

  @Post('switch-workspace')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Move this session into another workspace the same person belongs to' })
  switchWorkspace(@Request() req: any, @Body('tenantId') tenantId: string) {
    return this.authService.switchWorkspace(req.user.userId, tenantId);
  }

  @Post('service-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue a short-lived JWT for a trusted Next.js proxy call' })
  serviceToken(@Body() body: { userId: string; email: string; secret: string; businessId?: string }) {
    return this.authService.issueServiceToken(body.userId, body.email, body.secret, body.businessId);
  }

  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email with token from link' })
  async verifyEmail(@Query('token') token: string) {
    await this.authService.verifyEmail(token);
    return { message: 'Email verified successfully' };
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend email verification link' })
  async resendVerification(@Body('email') email: string) {
    await this.authService.resendVerification(email);
    return { message: 'If your email is unverified, a link has been sent' };
  }
}
