import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { InternalGuard } from '../auth/guards/internal.guard';
import { ProjectCopiesService } from './project-copies.service';
import type { ProjectCopyBody } from './project-copy.rules';

/**
 * Project duplicate (2026-10-07): crm-api's calls, service to service only
 * (x-internal-secret). The body limit for this path is raised in main.ts —
 * a large project's id maps do not fit express's default 100 kB.
 */
@ApiTags('Internal — project copies')
@Public()
@UseGuards(InternalGuard)
@Controller('internal/project-copies')
export class ProjectCopiesController {
  constructor(private readonly copies: ProjectCopiesService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Copy the warehouse rows of a copied project tree (idempotent by jobId)' })
  copy(@Body() body: ProjectCopyBody) {
    return this.copies.copy(body);
  }

  @Get(':jobId/preview')
  @ApiOperation({ summary: 'Counts a copy would make (old ids as comma lists)' })
  preview(
    @Param('jobId') jobId: string,
    @Query() query: { projectIds?: string; taskIds?: string; objectIds?: string },
  ) {
    return this.copies.preview(jobId, query ?? {});
  }

  @Delete(':jobId')
  @ApiOperation({ summary: 'Roll back everything a copy made' })
  rollback(@Param('jobId') jobId: string) {
    return this.copies.rollback(jobId);
  }
}
