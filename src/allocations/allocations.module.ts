import { Module } from '@nestjs/common';

import { AllocationsController } from './allocations.controller';
import { AllocationsService } from './allocations.service';

import { PrismaModule } from 'prisma/prisma.module';
import { ReservationsModule } from '../reservations/reservations.module';

@Module({
  imports: [PrismaModule, ReservationsModule],

  controllers: [AllocationsController],

  providers: [AllocationsService],

  exports: [AllocationsService],
})
export class AllocationsModule {}
