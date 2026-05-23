import { Module } from '@nestjs/common';

import { ResponsibilitiesController } from './responsibilities.controller';
import { ResponsibilitiesService } from './responsibilities.service';

@Module({
  controllers: [ResponsibilitiesController],
  providers: [ResponsibilitiesService],
  exports: [ResponsibilitiesService],
})
export class ResponsibilitiesModule {}
