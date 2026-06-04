import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProcurementService } from './procurement.service';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';
import { ProcurementOrderStatus } from '../common/enums/procurement-order-status.enum';

@ApiTags('Procurement')
@Controller('procurement')
export class ProcurementController {
  constructor(private readonly procurementService: ProcurementService) {}

  @Get()
  @ApiOperation({ summary: 'Get all procurement orders' })
  findAll() { return this.procurementService.findAll(); }

  @Get(':id')
  @ApiOperation({ summary: 'Get procurement order by id' })
  findOne(@Param('id', ParseIntPipe) id: number) { return this.procurementService.findOne(id); }

  @Post()
  @ApiOperation({ summary: 'Create procurement order' })
  create(@Body() dto: CreateProcurementDto) { return this.procurementService.create(dto); }

  @Patch(':id')
  @ApiOperation({ summary: 'Update procurement order' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProcurementDto) {
    return this.procurementService.update(id, dto);
  }

  @Patch(':id/order')
  @ApiOperation({ summary: 'Mark order as ORDERED' })
  markOrdered(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.updateStatus(id, ProcurementOrderStatus.ORDERED);
  }

  @Patch(':id/receive')
  @ApiOperation({ summary: 'Mark order as RECEIVED and update stock' })
  receive(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.receive(id);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancel procurement order' })
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.updateStatus(id, ProcurementOrderStatus.CANCELLED);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete procurement order' })
  remove(@Param('id', ParseIntPipe) id: number) { return this.procurementService.remove(id); }
}
