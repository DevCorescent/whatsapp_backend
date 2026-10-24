import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { GatewayModule } from './gateway.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(GatewayModule, { rawBody: true });

  // Security
  app.use(helmet());
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? '*',
    credentials: true,
  });

  // Global validation
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Wrap all responses in { success, data, pagination? } to match Next.js API shape
  app.useGlobalInterceptors(new TransformInterceptor());

  // Swagger — available at /api/docs
  const config = new DocumentBuilder()
    .setTitle('WhatsCRM API')
    .setDescription('NestJS microservices backend for WhatsCRM')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  const port = process.env.PORT ?? process.env.GATEWAY_PORT ?? 4000;
  await app.listen(port);
  console.log(`Gateway running on http://localhost:${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap();
