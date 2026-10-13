import { Body, Controller, Injectable, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PrismaService } from 'prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { InternalGuard } from '../auth/guards/internal.guard';

/**
 * The material cost the CRM objects tree rolls up, as sums instead of rows
 * (2026-10-13, performance plan). CRM used to post every object with the ids
 * of every task under it (internal/material-costs); at prod scale that body
 * passed the 100 kB limit and the tree showed "—" for every cost.
 *
 * Here CRM names only its objects. The answer is the net cost (issues add,
 * returns subtract, frozen costs — the materialCosts rule) grouped by what
 * decides which object a movement counts for: the object it is stamped with,
 * and — for OUT/IN rows — the task it was issued against. CRM maps tasks to
 * objects itself and adds each group to every object it belongs to, which is
 * exactly materialCosts' "stamped with the object OR an OUT/IN row of one of
 * its tasks".
 */
@Injectable()
export class MaterialCostRowsService {
  constructor(private readonly prisma: PrismaService) {}

  async rows(objectIds: number[]) {
    const ids = [...new Set((Array.isArray(objectIds) ? objectIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const rows = await this.prisma.$queryRaw<{ objectId: number | null; taskId: number | null; outIn: boolean; sum: number | null }[]>`
      SELECT
        CASE WHEN "objectId" = ANY(${ids}::int[]) THEN "objectId" END AS "objectId",
        CASE WHEN "type" IN ('OUT', 'IN') THEN "taskId" END AS "taskId",
        ("type" IN ('OUT', 'IN') AND "taskId" IS NOT NULL) AS "outIn",
        SUM(CASE WHEN "type" = 'OUT' THEN "totalCost" ELSE -"totalCost" END) AS "sum"
      FROM "InventoryMovement"
      WHERE "totalCost" IS NOT NULL
        AND ("objectId" = ANY(${ids}::int[]) OR ("taskId" IS NOT NULL AND "type" IN ('OUT', 'IN')))
      GROUP BY 1, 2, 3
    `;
    return {
      rows: rows.map((r) => ({
        objectId: r.objectId == null ? null : Number(r.objectId),
        taskId: r.outIn && r.taskId != null ? Number(r.taskId) : null,
        sum: Number(r.sum ?? 0),
      })),
    };
  }
}

@ApiTags('Objects')
@Controller('objects')
export class MaterialCostRowsController {
  constructor(private readonly service: MaterialCostRowsService) {}

  @Public()
  @UseGuards(InternalGuard)
  @Post('internal/material-cost-rows')
  @ApiOperation({ summary: 'Net material cost grouped by object and task (internal, CRM objects tree)' })
  rows(@Body() body: { objectIds?: number[] }) {
    return this.service.rows(body?.objectIds ?? []);
  }
}
