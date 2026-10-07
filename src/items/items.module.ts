import { Module } from '@nestjs/common';

import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { CategoriesModule } from 'src/categories/categories.module';
import { FileService } from '../common/file.service';
import { ReservationsModule } from '../reservations/reservations.module';

@Module({
  controllers: [ItemsController],
  providers: [ItemsService, FileService],
  exports: [ItemsService],
  // ReservationsModule: who is behind an open request (item_changed, 2026-10-07).
  imports: [CategoriesModule, ReservationsModule],
})
export class ItemsModule {}
