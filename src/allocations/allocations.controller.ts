import { Body, Controller, Delete, Get, Param, Post, Query,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { AllocationsService } from './allocations.service';

import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

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

  @UseGuards(PermissionGuard)
  @Permissions('view_reservations', 'manage_reservations')
  @Get()
  getAll(
    @Query()
    query: PaginationQueryDto,
  ) {
    return this.allocationsService.getAll(query);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_reservations', 'manage_reservations')
  @Get(':id')
  getOne(
    @Param('id')
    id: string,
  ) {
    return this.allocationsService.getOne(+id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @Delete(':id')
  remove(
    @Param('id')
    id: string,
  ) {
    return this.allocationsService.remove(+id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @Post('return')
  @ApiOperation({ summary: 'Return allocated resources back to warehouse' })
  returnAllocations(@Body() dto: ReturnAllocationsDto) {
    return this.allocationsService.returnAllocations(dto.returns);
  }
}
