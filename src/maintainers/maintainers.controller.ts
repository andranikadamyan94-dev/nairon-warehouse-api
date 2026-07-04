import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MaintainersService } from './maintainers.service';
import { CreateMaintainerDto } from './dto/create-maintainer.dto';
import { UpdateMaintainerDto } from './dto/update-maintainer.dto';

@ApiTags('Maintainers')
@Controller('maintainers')
export class MaintainersController {
  constructor(private readonly maintainersService: MaintainersService) {}

  @Get()
  @ApiOperation({ summary: 'Get all maintainers' })
  findAll() { return this.maintainersService.findAll(); }

  @Get(':id')
  @ApiOperation({ summary: 'Get maintainer by id' })
  findOne(@Param('id', ParseIntPipe) id: number) { return this.maintainersService.findOne(id); }

  @Post()
  @ApiOperation({ summary: 'Create maintainer' })
  create(@Body() dto: CreateMaintainerDto) { return this.maintainersService.create(dto); }

  @Patch(':id')
  @ApiOperation({ summary: 'Update maintainer' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMaintainerDto) {
    return this.maintainersService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete maintainer' })
  remove(@Param('id', ParseIntPipe) id: number) { return this.maintainersService.remove(id); }
}
