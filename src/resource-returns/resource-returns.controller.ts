import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ResourceReturnsService } from './resource-returns.service';
import { CreateReturnDto } from './dto/create-return.dto';
import { ResourceReturnStatus } from '../common/enums/resource-return-status.enum';

import { LoggedInUser } from '../auth/decorators/logged-in-user.decorator';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { Actor } from '../auth/decorators/actor.decorator';
import { OperationsService } from '../common/operations/operations.service';
import { OperationKey } from '../common/operations/operation-key.decorator';
import { WarehouseActor } from '../auth/actor';

@ApiTags('resource-returns')
@ApiBearerAuth()
@Controller('resource-returns')
export class ResourceReturnsController {
  constructor(
    private readonly service: ResourceReturnsService,
    private readonly operations: OperationsService,
  ) {}

  @Post()
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse', 'manage_resource_returns')
  async create(
    @Body() dto: CreateReturnDto,
    @Actor() actor: WarehouseActor,
    /* Handing back twice hands back twice as much. See OperationsService. */
    @OperationKey() operationKey?: string,
  ) {
    const { result } = await this.operations.runOnce(
      { key: operationKey, actor, route: 'POST /resource-returns', body: dto },
      () => this.service.create(dto, actor),
    );
    return result;
  }

  @Get()
  findAll(
    @Actor() actor: WarehouseActor,
    @Query('status') status?: ResourceReturnStatus,
    @Query('taskId') taskId?: string,
  ) {
    return this.service.findAll(
      { status, taskId: taskId ? Number(taskId) : undefined },
      actor,
    );
  }

  @Patch(':id/receive')
  @UseGuards(PermissionGuard)
  @Permissions('manage_resource_returns')
  receive(
    @Param('id') id: string,
    @LoggedInUser('id') userId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.service.receive(+id, userId, actor);
  }

  @Patch(':id/cancel')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse', 'manage_resource_returns')
  cancel(@Param('id') id: string, @Actor() actor: WarehouseActor) {
    return this.service.cancel(+id, actor);
  }
}
