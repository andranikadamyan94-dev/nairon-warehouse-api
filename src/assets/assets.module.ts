import { Module } from '@nestjs/common';

import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { ObjectsModule } from '../objects/objects.module';
import { ReservationsModule } from '../reservations/reservations.module';

@Module({
  // Who holds an asset — an object's responsible person, a task's people (phase 3, 2026-10-07).
  imports: [ObjectsModule, ReservationsModule],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
