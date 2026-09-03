import { Module } from '@nestjs/common';

import { StockRequestsController } from './stock-requests.controller';
import { StockRequestsService } from './stock-requests.service';
import { WarehousesModule } from '../warehouses/warehouses.module';
import { StockTransfersModule } from '../stock-transfers/stock-transfers.module';

@Module({
  imports: [WarehousesModule, StockTransfersModule],
  controllers: [StockRequestsController],
  providers: [StockRequestsService],
})
export class StockRequestsModule {}
