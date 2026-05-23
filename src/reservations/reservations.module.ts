import { Module } from '@nestjs/common';

import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { AvailabilityService } from 'src/availability/availability.service';

@Module({
  controllers: [ReservationsController],
  providers: [ReservationsService, AvailabilityService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
