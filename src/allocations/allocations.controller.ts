import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';

import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { AllocationsService } from './allocations.service';

import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

class ReturnItemDto {
  @IsInt()
  allocationId: number;

  @IsOptional()
  @IsNumber()
  quantity?: number;
}

class ReturnAllocationsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  returns: ReturnItemDto[];
}

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

  @Post('return')
  @ApiOperation({ summary: 'Return allocated resources back to warehouse' })
  returnAllocations(@Body() dto: ReturnAllocationsDto) {
    return this.allocationsService.returnAllocations(dto.returns);
  }
}
