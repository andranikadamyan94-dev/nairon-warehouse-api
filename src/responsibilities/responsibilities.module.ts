import { Module } from '@nestjs/common';

import { ResponsibilitiesController } from './responsibilities.controller';
import { ResponsibilitiesService } from './responsibilities.service';
import { DelegatedWriteMembership } from '../auth/delegated-write.membership';

@Module({
  controllers: [ResponsibilitiesController],
  providers: [ResponsibilitiesService, DelegatedWriteMembership],
  exports: [ResponsibilitiesService],
})
export class ResponsibilitiesModule {}
