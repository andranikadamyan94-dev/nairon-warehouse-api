import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProcurementService } from './procurement.service';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';
import { ProcurementOrderStatus } from '../common/enums/procurement-order-status.enum';
import { Public } from '../auth/decorators/public.decorator';
import { InternalGuard } from '../auth/guards/internal.guard';

@ApiTags('Procurement')
@Controller('procurement')
export class ProcurementController {
  constructor(private readonly procurementService: ProcurementService) {}

  @Get()
  @ApiOperation({ summary: 'Get all procurement orders' })
  findAll(@Query() query: any) { return this.procurementService.findAll(query); }

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

  @Post(':id/finalize')
  @ApiOperation({ summary: 'Finalize order — sends to finance for approval' })
  finalize(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.finalize(id);
  }

  @Public()
  @UseGuards(InternalGuard)
  @Get(':id/internal')
  @ApiOperation({ summary: 'Get procurement order details (internal, called by finance API)' })
  findOneInternal(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.findOne(id);
  }

  @Public()
  @UseGuards(InternalGuard)
  @Post(':id/finance-callback')
  @ApiOperation({ summary: 'Finance approval callback (called by finance API)' })
  financeCallback(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: 'APPROVED' | 'REJECTED' },
  ) {
    return this.procurementService.financeCallback(id, body.status);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete procurement order' })
  remove(@Param('id', ParseIntPipe) id: number) { return this.procurementService.remove(id); }
}
