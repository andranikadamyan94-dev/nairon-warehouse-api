import * as path from 'path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { PrismaService } from 'prisma/prisma.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  (app.getHttpServer() as any).maxHeaderSize = 65536;
  app.useStaticAssets(path.join(process.cwd(), 'uploads'), { prefix: '/uploads' });

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
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

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
