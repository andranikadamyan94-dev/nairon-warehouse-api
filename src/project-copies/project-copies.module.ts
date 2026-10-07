import { Module } from '@nestjs/common';

import { FileService } from '../common/file.service';
import { ReservationsModule } from '../reservations/reservations.module';
import { ProjectCopiesController } from './project-copies.controller';
import { ProjectCopiesService } from './project-copies.service';

/** Project duplicate (2026-10-07): the warehouse half of crm's «Պատճենել նախագիծը». */
@Module({
  imports: [ReservationsModule],
  controllers: [ProjectCopiesController],
  providers: [ProjectCopiesService, FileService],
})
export class ProjectCopiesModule {}
