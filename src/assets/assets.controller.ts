import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AssetsService } from './assets.service';

import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

@ApiTags('Assets')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @UseGuards(PermissionGuard)
  @Permissions('manage_assets')
  @Post()
  @ApiOperation({
    summary: 'Create asset',
  })
  create(
    @Body()
    dto: CreateAssetDto,
  ) {
    return this.assetsService.create(dto);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_assets', 'manage_assets')
  @Get()
  @ApiOperation({
    summary: 'Get all assets',
  })
  findAll(@Query() query: any) {
    return this.assetsService.findAll(query);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_assets', 'manage_assets')
  @Get('item/:itemId')
  getItemHistory(@Param('itemId', ParseIntPipe) itemId: number) {
    return this.assetsService.getItemHistory(itemId);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_reservations', 'manage_reservations')
  @Get('available')
  getAvailable(
    @Query('itemId') itemId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('reservationId') reservationId?: string,
  ) {
    return this.assetsService.getAvailableAssets({
      itemId: +itemId,
      startDate,
      endDate,
      reservationId: reservationId ? +reservationId : undefined,
    });
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_assets', 'manage_assets')
  @Get(':id')
  @ApiOperation({
    summary: 'Get asset by id',
  })
  findOne(
    @Param('id', ParseIntPipe)
    id: number,
  ) {
    return this.assetsService.findOne(id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_assets')
  @Patch(':id')
  @ApiOperation({
    summary: 'Update asset',
  })
  update(
    @Param('id', ParseIntPipe)
    id: number,

    @Body()
    dto: UpdateAssetDto,
  ) {
    return this.assetsService.update(id, dto);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_assets')
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete asset',
  })
  remove(
    @Param('id', ParseIntPipe)
    id: number,
  ) {
    return this.assetsService.remove(id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_assets', 'manage_assets')
  @Get(':id/history')
  getHistory(
    @Param('id')
    id: string,
  ) {
    return this.assetsService.getAssetHistory(+id);
  }
}
