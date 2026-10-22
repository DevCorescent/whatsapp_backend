import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { Request } from 'express';
import { AuthService } from '../auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    super({ usernameField: 'email', passReqToCallback: true });
  }

  validate(req: Request, email: string, password: string) {
    const tenantSlug = (req.body as any).tenantSlug ?? '';
    return this.authService.validateUser(email, password, tenantSlug);
  }
}
