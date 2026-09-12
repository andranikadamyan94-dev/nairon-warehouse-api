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
import { Actor } from '../auth/decorators/actor.decorator';
import { WarehouseActor } from '../auth/actor';
import { PREFLIGHT_OK } from '../common/preflight/preflight';

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

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.assetsService.create(dto, actor);
  }

  /** Writes nothing; see src/common/preflight/preflight.ts. */
  @UseGuards(PermissionGuard)
  @Permissions('manage_assets')
  @Post('preflight/create')
  async preflightCreate(@Body() dto: CreateAssetDto, @Actor() actor: WarehouseActor) {
    await this.assetsService.assertMayCreateFor(actor, dto.itemId);
    return PREFLIGHT_OK;
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_assets')
  @Post('preflight/update/:id')
  async preflightUpdate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAssetDto,
    @Actor() actor: WarehouseActor,
  ) {
    await this.assetsService.findOne(id, actor);
    await this.assetsService.assertMayEdit(actor, id);
    if (dto.itemId !== undefined) await this.assetsService.assertMayCreateFor(actor, dto.itemId);
    return PREFLIGHT_OK;
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_assets')
  @Post('preflight/delete/:id')
  async preflightDelete(@Param('id', ParseIntPipe) id: number, @Actor() actor: WarehouseActor) {
    await this.assetsService.findOne(id, actor);
    await this.assetsService.assertMayEdit(actor, id);
    return PREFLIGHT_OK;
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_assets', 'manage_assets')
  @Get()
  @ApiOperation({
    summary: 'Get all assets',
  })
  findAll(@Query() query: any, @Actor() actor: WarehouseActor) {
    return this.assetsService.findAll(query, actor);
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

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.assetsService.findOne(id, actor);
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

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.assetsService.update(id, dto, actor);
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

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.assetsService.remove(id, actor);
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
