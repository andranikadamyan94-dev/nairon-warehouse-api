import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class UsersService {
  private readonly authApiUrl: string;

  constructor(private readonly config: ConfigService) {
    this.authApiUrl = this.config.get<string>('AUTH_API_URL', 'http://localhost:3002');
  }

  async getAll() {
    const res = await fetch(`${this.authApiUrl}/api/users`);
    return res.json();
  }
}