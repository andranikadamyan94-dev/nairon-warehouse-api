import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requireInternalSecret } from '../common/internal-headers';
import { TtlCache } from '../common/cache/ttl-cache';

export type UserName = { id: number; firstName: string; lastName: string };

/** How long the directory is reused (performance audit 2026-10-13, H4). */
export const USERS_TTL_MS = 60_000;

@Injectable()
export class UsersService {
  private readonly authApiUrl: string;
  private readonly cache = new TtlCache<'all', UserName[]>(USERS_TTL_MS, 1);

  constructor(private readonly config: ConfigService) {
    this.authApiUrl = this.config.get<string>('AUTH_API_URL', 'http://localhost:3002');
  }

  /**
   * Backs the responsible-person and maintainer pickers. Auth leaves
   * deactivated users out by default, which is what we want here — an asset
   * must not be handed to someone who has left.
   *
   * Names only, cached a minute (performance audit 2026-10-13): every page
   * that named a person downloaded each user's roles and permissions (~410 KB
   * on staging), and every caller — the warehouse client's pages and
   * nairon-ai-api's warehouse tools — reads only id, firstName and lastName.
   * Someone deactivated a moment ago may linger in a picker for that minute.
   */
  async getAll(): Promise<UserName[] | unknown> {
    try {
      return await this.cache.get('all', () => this.load());
    } catch (e) {
      // Not a directory (auth refused or failed): hand back what auth said, as before, uncached.
      if (e instanceof NotADirectory) return e.body;
      throw e;
    }
  }

  private async load(): Promise<UserName[]> {
    // Auth's user routes are service-to-service and authenticate with the
    // shared internal secret the rest of the platform already uses.
    const res = await fetch(`${this.authApiUrl}/api/users?limit=10000`, {
      headers: { 'x-internal-secret': requireInternalSecret() },
    });
    const body: any = await res.json();
    const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    if (!res.ok || !rows) throw new NotADirectory(body);
    return rows.map((u: any) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName }));
  }
}

class NotADirectory extends Error {
  constructor(readonly body: unknown) {
    super('auth /users did not answer a list');
  }
}
