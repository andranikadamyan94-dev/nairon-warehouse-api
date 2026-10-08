import { Module } from '@nestjs/common';

import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { AvailabilityService } from 'src/availability/availability.service';

import { AssetCustodyModule } from '../asset-custody/asset-custody.module';

@Module({
  // Object custody on equipment hand-out (2026-10-08): the custody register moves units to and from objects.
  imports: [AssetCustodyModule],
  controllers: [ReservationsController],
  providers: [ReservationsService, AvailabilityService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
