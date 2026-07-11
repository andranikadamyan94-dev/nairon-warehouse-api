import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ResponsibilitiesService } from './responsibilities.service';

import { AssignResponsibilityDto } from './dto/assign-responsibility.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

@ApiTags('Responsibilities')
@Controller('responsibilities')
export class ResponsibilitiesController {
  constructor(
    private readonly responsibilitiesService: ResponsibilitiesService,
  ) {}

  @UseGuards(PermissionGuard)
  @Permissions('manage_responsibilities')
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

  @UseGuards(PermissionGuard)
  @Permissions('manage_responsibilities')
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

  @UseGuards(PermissionGuard)
  @Permissions('view_responsibilities', 'manage_responsibilities')
  @Get()
  getAll() {
    return this.responsibilitiesService.getAll();
  }

  @Get('user/:userId')
  getUserResponsibilities(
    @Param('userId')
    userId: string,
  ) {
    return this.responsibilitiesService.getUserResponsibilities(+userId);
  }
}
