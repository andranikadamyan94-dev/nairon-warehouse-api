import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ResourceReturnsService } from './resource-returns.service';
import { CreateReturnDto } from './dto/create-return.dto';
import { ResourceReturnStatus } from '../common/enums/resource-return-status.enum';
import { WarehouseStaffGuard } from '../auth/guards/warehouse-staff.guard';
import { LoggedInUser } from '../auth/decorators/logged-in-user.decorator';

@ApiTags('resource-returns')
@ApiBearerAuth()
@Controller('resource-returns')
export class ResourceReturnsController {
  constructor(private readonly service: ResourceReturnsService) {}

  @Post()
  create(@Body() dto: CreateReturnDto) {
    return this.service.create(dto);
  }

  @Get()
  findAll(
    @Query('status') status?: ResourceReturnStatus,
    @Query('taskId') taskId?: string,
  ) {
    return this.service.findAll({
      status,
      taskId: taskId ? Number(taskId) : undefined,
    });
  }

  @Patch(':id/receive')
  @UseGuards(WarehouseStaffGuard)
  receive(@Param('id') id: string, @LoggedInUser('id') userId: number) {
    return this.service.receive(+id, userId);
  }

  @Patch(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.service.cancel(+id);
  }
}
