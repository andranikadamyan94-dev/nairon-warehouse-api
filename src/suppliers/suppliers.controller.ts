import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

@ApiTags('Suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  @ApiOperation({ summary: 'Get all suppliers' })
  findAll(@Query() query: any) { return this.suppliersService.findAll(query); }

  @Get(':id')
  @ApiOperation({ summary: 'Get supplier by id' })
  findOne(@Param('id', ParseIntPipe) id: number) { return this.suppliersService.findOne(id); }

  @Post()
  @ApiOperation({ summary: 'Create supplier' })
  create(@Body() dto: CreateSupplierDto) { return this.suppliersService.create(dto); }

  @Patch(':id')
  @ApiOperation({ summary: 'Update supplier' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSupplierDto) {
    return this.suppliersService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete supplier' })
  remove(@Param('id', ParseIntPipe) id: number) { return this.suppliersService.remove(id); }
}
