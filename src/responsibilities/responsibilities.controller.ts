import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

import { ResponsibilitiesService } from './responsibilities.service';

import { AssignResponsibilityDto } from './dto/assign-responsibility.dto';

@Controller('responsibilities')
export class ResponsibilitiesController {
  constructor(
    private readonly responsibilitiesService: ResponsibilitiesService,
  ) {}

  @Post()
  assign(
    @Body()
    dto: AssignResponsibilityDto,
  ) {
    return this.responsibilitiesService.assign(dto);
  }

  @Delete(':assetId')
  release(
    @Param('assetId', ParseIntPipe)
    assetId: number,
  ) {
    return this.responsibilitiesService.release(assetId);
  }

  @Get(':assetId/history')
  getAssetHistory(
    @Param('assetId', ParseIntPipe)
    assetId: number,
  ) {
    return this.responsibilitiesService.getAssetHistory(assetId);
  }
}
