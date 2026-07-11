import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MaintainersService } from './maintainers.service';
import { CreateMaintainerDto } from './dto/create-maintainer.dto';
import { UpdateMaintainerDto } from './dto/update-maintainer.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

@ApiTags('Maintainers')
@Controller('maintainers')
export class MaintainersController {
  constructor(private readonly maintainersService: MaintainersService) {}

  @UseGuards(PermissionGuard)
  @Permissions('view_partners', 'manage_partners', 'view_maintenance', 'manage_maintenance')
  @Get()
  @ApiOperation({ summary: 'Get all maintainers' })
  findAll() { return this.maintainersService.findAll(); }

  @UseGuards(PermissionGuard)
  @Permissions('view_partners', 'manage_partners', 'view_maintenance', 'manage_maintenance')
  @Get(':id')
  @ApiOperation({ summary: 'Get maintainer by id' })
  findOne(@Param('id', ParseIntPipe) id: number) { return this.maintainersService.findOne(id); }

  @UseGuards(PermissionGuard)
  @Permissions('manage_partners')
  @Post()
  @ApiOperation({ summary: 'Create maintainer' })
  create(@Body() dto: CreateMaintainerDto) { return this.maintainersService.create(dto); }

  @UseGuards(PermissionGuard)
  @Permissions('manage_partners')
  @Patch(':id')
  @ApiOperation({ summary: 'Update maintainer' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMaintainerDto) {
    return this.maintainersService.update(id, dto);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_partners')
  @Delete(':id')
  @ApiOperation({ summary: 'Delete maintainer' })
  remove(@Param('id', ParseIntPipe) id: number) { return this.maintainersService.remove(id); }
}
