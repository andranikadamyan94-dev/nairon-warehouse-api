import { INestApplication, Injectable, OnModuleInit } from '@nestjs/common';

import { PrismaClient } from '@prisma/client';

// Prisma sizes its pool from the host CPU count when the URL doesn't say
// otherwise; nine uncapped pools across the five APIs saturated prod
// Postgres's 100 slots (P2037, 2026-09-01). A URL that already carries
// connection_limit wins; DB_POOL_LIMIT overrides the default per environment.
const pooledUrl = (url: string | undefined, envVar: string, fallback: number) => {
  if (!url || url.includes('connection_limit=')) return url;
  const limit = Number(process.env[envVar]) > 0 ? Number(process.env[envVar]) : fallback;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${limit}&pool_timeout=20`;
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super({ datasources: { db: { url: pooledUrl(process.env.DATABASE_URL, 'DB_POOL_LIMIT', 8) } } });
  }

  async onModuleInit() {
    await this.$connect();
    setInterval(() => {
      this.$queryRaw`SELECT 1`.catch(() => {});
    }, 4 * 60 * 1000);
  }

  async enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', async () => {
      await app.close();
    });
  }
}
