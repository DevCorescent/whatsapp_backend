import { Controller, Get } from '@nestjs/common';

@Controller()
export class GatewayController {
  @Get('ping')
  ping() {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}
