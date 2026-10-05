import { Module } from '@nestjs/common';

import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { CategoriesModule } from '../categories/categories.module';
import { FileService } from '../common/file.service';
import { PurchaseRequisitionsModule } from '../purchase-requisitions/purchase-requisitions.module';
import { ReservationsModule } from '../reservations/reservations.module';

/**
 * Warehouse «Կատալոգ» (2026-10-01): the employee-facing front door onto
 * reservations and purchase requisitions. Both services are imported, not
 * re-implemented — the catalog only groups what they make.
 */
@Module({
  imports: [ReservationsModule, PurchaseRequisitionsModule, CategoriesModule],
  controllers: [CatalogController],
  providers: [CatalogService, FileService],
})
export class CatalogModule {}
