import { Controller, Get, Headers } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

@ApiTags('Entities')
@ApiBearerAuth()
@Controller('entities')
export class EntitiesController {
  private readonly hrUrl: string;

  constructor(config: ConfigService) {
    this.hrUrl = config.get<string>('HR_SERVICE_URL', 'http://localhost:3001');
  }

  @Get()
  async findAll(@Headers('authorization') authorization: string) {
    try {
      const res = await fetch(`${this.hrUrl}/api/entities`, {
        headers: { Authorization: authorization },
      });
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  }
}
