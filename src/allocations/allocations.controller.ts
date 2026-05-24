import { Controller, Delete, Get, Param, Query } from '@nestjs/common';

import { ApiTags } from '@nestjs/swagger';

import { AllocationsService } from './allocations.service';

import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

@ApiTags('Allocations')
@Controller('allocations')
export class AllocationsController {
  constructor(private readonly allocationsService: AllocationsService) {}

  @Get()
  getAll(
    @Query()
    query: PaginationQueryDto,
  ) {
    return this.allocationsService.getAll(query);
  }

  @Get(':id')
  getOne(
    @Param('id')
    id: string,
  ) {
    return this.allocationsService.getOne(+id);
  }

  @Delete(':id')
  remove(
    @Param('id')
    id: string,
  ) {
    return this.allocationsService.remove(+id);
  }
}
