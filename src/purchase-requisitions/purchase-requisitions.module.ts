import { Module } from '@nestjs/common';

import { PurchaseRequisitionsController } from './purchase-requisitions.controller';
import { PurchaseRequisitionsService } from './purchase-requisitions.service';
import { FileService } from '../common/file.service';

@Module({
  controllers: [PurchaseRequisitionsController],
  // UsersPrismaService comes from the global AppModule providers.
  providers: [PurchaseRequisitionsService, FileService],
  exports: [PurchaseRequisitionsService],
})
export class PurchaseRequisitionsModule {}
