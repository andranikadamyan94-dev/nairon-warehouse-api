import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ResponsibilitiesService } from './responsibilities.service';

import { AssignResponsibilityDto } from './dto/assign-responsibility.dto';

@ApiTags('Responsibilities')
@Controller('responsibilities')
export class ResponsibilitiesController {
  constructor(
    private readonly responsibilitiesService: ResponsibilitiesService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Assign asset responsibility',
  })
  @ApiResponse({
    status: 201,
  })
  assign(
    @Body()
    dto: AssignResponsibilityDto,
  ) {
    return this.responsibilitiesService.assign(dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Release responsibility',
  })
  @ApiResponse({
    status: 200,
  })
  release(
    @Param('id', ParseIntPipe)
    id: number,
  ) {
    return this.responsibilitiesService.release(id);
  }

  @Get()
  getAll(@Query('entityId') entityId?: string) {
    return this.responsibilitiesService.getAll(entityId ? Number(entityId) : undefined);
  }

  @Get('user/:userId')
  getUserResponsibilities(
    @Param('userId')
    userId: string,
  ) {
    return this.responsibilitiesService.getUserResponsibilities(+userId);
  }
}
