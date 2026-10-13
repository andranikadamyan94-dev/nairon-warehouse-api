import { Module } from '@nestjs/common';

import { ObjectsController } from './objects.controller';
import { ObjectsService } from './objects.service';
import { MaterialCostRowsController, MaterialCostRowsService } from './material-cost-rows';

@Module({
  controllers: [ObjectsController, MaterialCostRowsController],
  providers: [ObjectsService, MaterialCostRowsService],
  exports: [ObjectsService],
})
export class ObjectsModule {}
