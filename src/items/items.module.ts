import { Module } from '@nestjs/common';

import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { CategoriesModule } from 'src/categories/categories.module';

@Module({
  controllers: [ItemsController],
  providers: [ItemsService],
  exports: [ItemsService],
  imports: [CategoriesModule],
})
export class ItemsModule {}
