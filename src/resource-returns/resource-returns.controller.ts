import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ResourceReturnsService } from './resource-returns.service';
import { CreateReturnDto } from './dto/create-return.dto';
import { ResourceReturnStatus } from '../common/enums/resource-return-status.enum';

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
  receive(@Param('id') id: string, @Body('receivedBy') receivedBy?: number) {
    return this.service.receive(+id, receivedBy);
  }

  @Patch(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.service.cancel(+id);
  }
}
