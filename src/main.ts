import { assertJwtConfigured } from './auth/constants';
import * as path from 'path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { PrismaService } from 'prisma/prisma.service';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { armenianValidationPipe } from './common/validation-messages';

async function bootstrap() {
  // A signing key has no safe default; refuse to start rather than fall back
  // to one published in this repository. See auth/constants.ts.
  assertJwtConfigured();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  (app.getHttpServer() as any).maxHeaderSize = 65536;
  /*
   * Receipts are no longer served straight off the directory.
   *
   * There were two static mounts here, `/uploads` and `/api/uploads`, and both
   * are express middleware rather than routes — so neither AuthGuard nor
   * PermissionGuard ever ran on them. Every procurement and delivery receipt,
   * with its supplier, quantities and prices, was readable by anyone who could
   * reach the service with the URL, signed in or not.
   *
   * Both forms still resolve: the gateway strips its /warehouse segment and
   * prepends /api, and a stored "/uploads/x" resolved against a client's API
   * base arrives as one or the other. They now reach the authorized route in
   * files/files.controller.ts instead of the filesystem.
   */
  app.use((req: any, _res: any, next: () => void) => {
    if (typeof req.url === 'string' && req.url.startsWith('/uploads/')) req.url = `/api${req.url}`;
    next();
  });

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3004',
      'http://localhost:4001',
      'http://localhost:4002',
      'http://localhost:4003',
      'http://localhost:4004',
      'https://gateway.nairon.am',
      'https://nairon.am',
      'https://www.nairon.am',
      'https://warehouse.nairon.am',
      'https://crm.nairon.am',
      'https://finance.nairon.am',
      process.env.FRONTEND_URL,
    ].filter(Boolean),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // Every client app's axios interceptor attaches X-Entity-ID once an
    // entity is selected. Without it here the preflight is refused and the
    // request never reaches a route — crm-api, hr-api and auth-api were
    // already fixed for this, this one was missed.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Entity-ID', 'Idempotency-Key'],
    credentials: true,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(armenianValidationPipe());

  // Without this a broken unique constraint (e.g. a duplicate item code)
  // escapes as a bare 500 with no body, leaving the UI nothing to show.
  app.useGlobalFilters(new PrismaExceptionFilter());

  const config = new DocumentBuilder()
    .setTitle('Warehouse API')
    .setDescription('Warehouse management service API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, document);

  const prismaService = app.get(PrismaService);

  await prismaService.enableShutdownHooks(app);

  const port = process.env.PORT ?? 3005;

  await app.listen(port);

  console.log(`Warehouse service running on port ${port}`);

  console.log(`Swagger: http://localhost:${port}/docs`);
}

bootstrap();
