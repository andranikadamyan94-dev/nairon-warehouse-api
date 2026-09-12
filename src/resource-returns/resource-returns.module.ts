import { Module } from '@nestjs/common';
import { ResourceReturnsController } from './resource-returns.controller';
import { ResourceReturnsService } from './resource-returns.service';
import { ReservationsModule } from '../reservations/reservations.module';

/**
 * Returns lean on reservations for one question: is this person on the task?
 *
 * CRM is the authority on that, and ReservationsService already asks it for
 * task-side acceptance. Importing the module rather than repeating the call
 * keeps one answer to one question — and the returns list had no answer to it
 * at all until this phase, so naming a task id was enough to read any task's
 * returns.
 */
@Module({
  imports: [ReservationsModule],
  controllers: [ResourceReturnsController],
  providers: [ResourceReturnsService],
})
export class ResourceReturnsModule {}
