import {
  Body,
  Controller,
  Delete,
  Param,
  ParseIntPipe,
  Post,
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
}
