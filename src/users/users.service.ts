import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class UsersService {
  private readonly authApiUrl: string;

  constructor(private readonly config: ConfigService) {
    this.authApiUrl = this.config.get<string>('AUTH_API_URL', 'http://localhost:3002');
  }

  /**
   * Backs the responsible-person and maintainer pickers. Auth leaves
   * deactivated users out by default, which is what we want here — an asset
   * must not be handed to someone who has left.
   */
  async getAll() {
    // Auth's user routes are service-to-service and authenticate with the
    // shared internal secret the rest of the platform already uses.
    const res = await fetch(`${this.authApiUrl}/api/users?limit=10000`, {
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
    });
    return res.json();
  }
}