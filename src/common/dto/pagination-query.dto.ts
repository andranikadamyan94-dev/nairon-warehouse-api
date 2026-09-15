import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsIn, IsNumberString, IsOptional, IsString } from 'class-validator';

export class PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  page?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  limit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  entityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  // The client's tables have sent these since 2026-06-19 and the services
  // already implement them — but they were never declared here, so the
  // whitelist pipe 400'd every sorted list request.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: string;

  // Reservations list only: paginate by task-group instead of by row, so a
  // task's reservations always arrive complete (never split across pages).
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['1'])
  groupByTask?: string;

  /** #1989 workspaces: 'main' or a sub-warehouse id — scopes the list. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warehouseId?: string;
}
