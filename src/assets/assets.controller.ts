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
} from '@nestjs/common';

import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AssetsService } from './assets.service';

import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';

@ApiTags('Assets')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

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

  @Get()
  @ApiOperation({
    summary: 'Get all assets',
  })
  findAll(@Query('entityId') entityId?: string) {
    return this.assetsService.findAll(entityId ? Number(entityId) : undefined);
  }

  @Get('available')
  getAvailable(
    @Query('itemId')
    itemId: string,

    @Query('startDate')
    startDate: string,

    @Query('endDate')
    endDate: string,

    @Query('entityId')
    entityId?: string,
  ) {
    return this.assetsService.getAvailableAssets({
      itemId: +itemId,
      startDate,
      endDate,
      entityId: entityId ? +entityId : undefined,
    });
  }

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

  @Get(':id/history')
  getHistory(
    @Param('id')
    id: string,
  ) {
    return this.assetsService.getAssetHistory(+id);
  }
}
