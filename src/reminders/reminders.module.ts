import { Module } from '@nestjs/common';

import { WarehouseRemindersService } from './reminders.service';
import { ReservationsModule } from '../reservations/reservations.module';
import { ObjectsModule } from '../objects/objects.module';

/** The daily 09:00 Asia/Yerevan reminder run (notifications phase 3, 2026-10-07). */
@Module({
  imports: [ReservationsModule, ObjectsModule],
  providers: [WarehouseRemindersService],
  exports: [WarehouseRemindersService],
})
export class RemindersModule {}
