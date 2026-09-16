import { Controller, Get, Patch, Headers, Body, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

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

  /**
   * Every organization, id + name, regardless of the caller's memberships.
   *
   * A purchase order is bought FOR an organization, and procurement buys for
   * all of them — the buyer's own memberships say nothing about who the goods
   * are for. So the procurement form offers the whole directory (HR's internal
   * list, the one the cross-entity request picker uses), not the scoped list
   * above. Reading it takes the procurement permission; what the order then
   * does with the organization is procurement's business, as before.
   */
  @Get('all')
  @UseGuards(PermissionGuard)
  @Permissions('view_procurement', 'manage_procurement')
  @ApiOperation({ summary: 'All organizations (id + name) for the procurement form' })
  async findAllUnscoped(): Promise<{ id: number; name: string }[]> {
    try {
      const res = await fetch(`${this.hrUrl}/api/entities/internal/all`, {
        headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || 'nairon-internal' },
      });
      if (!res.ok) return [];
      const rows = (await res.json()) as { id: number; name: string }[];
      return Array.isArray(rows) ? rows.map((e) => ({ id: e.id, name: e.name })) : [];
    } catch {
      return [];
    }
  }

  @Get('app-config')
  async getAppConfig(@Headers('authorization') authorization: string) {
    try {
      const res = await fetch(`${this.hrUrl}/api/app-config`, {
        headers: { Authorization: authorization },
      });
      if (!res.ok) return {};
      return res.json();
    } catch {
      return {};
    }
  }

  @Patch('app-config')
  async updateAppConfig(
    @Headers('authorization') authorization: string,
    @Body() body: { logo?: string | null; favicon?: string | null },
  ) {
    const res = await fetch(`${this.hrUrl}/api/app-config`, {
      method: 'PATCH',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }
}