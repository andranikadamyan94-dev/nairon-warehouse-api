import { Module } from '@nestjs/common';

import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { ObjectsModule } from '../objects/objects.module';
import { TaskLabelsService } from '../common/task-labels.service';

@Module({
  imports: [ObjectsModule],
  controllers: [InventoryController],
  providers: [InventoryService, TaskLabelsService],
  exports: [InventoryService],
})
export class InventoryModule {}
