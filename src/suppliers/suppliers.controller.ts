import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

@ApiTags('Suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @UseGuards(PermissionGuard)
  @Permissions('view_partners', 'manage_partners', 'view_procurement', 'manage_procurement')
  @Get()
  @ApiOperation({ summary: 'Get all suppliers' })
  findAll(@Query() query: any) { return this.suppliersService.findAll(query); }

  @UseGuards(PermissionGuard)
  @Permissions('view_partners', 'manage_partners', 'view_procurement', 'manage_procurement')
  @Get(':id')
  @ApiOperation({ summary: 'Get supplier by id' })
  findOne(@Param('id', ParseIntPipe) id: number) { return this.suppliersService.findOne(id); }

  @UseGuards(PermissionGuard)
  @Permissions('manage_partners')
  @Post()
  @ApiOperation({ summary: 'Create supplier' })
  create(@Body() dto: CreateSupplierDto) { return this.suppliersService.create(dto); }

  @UseGuards(PermissionGuard)
  @Permissions('manage_partners')
  @Patch(':id')
  @ApiOperation({ summary: 'Update supplier' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSupplierDto) {
    return this.suppliersService.update(id, dto);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_partners')
  @Delete(':id')
  @ApiOperation({ summary: 'Delete supplier' })
  remove(@Param('id', ParseIntPipe) id: number) { return this.suppliersService.remove(id); }
}
