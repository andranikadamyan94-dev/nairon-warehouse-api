import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ResponsibilitiesService } from './responsibilities.service';

import { AssignResponsibilityDto } from './dto/assign-responsibility.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { Actor } from '../auth/decorators/actor.decorator';
import { WarehouseActor } from '../auth/actor';

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
    @Req() req?: any,
  ) {
    return this.responsibilitiesService.assign(dto, req?.user?.id);
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
    @Req() req?: any,
  ) {
    return this.responsibilitiesService.release(id, req?.user?.id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_responsibilities', 'manage_responsibilities')
  @Get()
  getAll() {
    return this.responsibilitiesService.getAll();
  }

  // Your own always; somebody else's per holdings-access.ts (a responsibility
  // or custody right — the warehouse is global, no organisation is asked).
  @Get('user/:userId')
  async getUserResponsibilities(
    @Param('userId', ParseIntPipe)
    userId: number,
    @Actor() actor: WarehouseActor,
  ) {
    this.responsibilitiesService.assertMayReadHoldings(actor, userId);
    return this.responsibilitiesService.getUserResponsibilities(userId);
  }
}
