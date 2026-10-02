import { Module } from '@nestjs/common';

import { ResponsibilitiesController } from './responsibilities.controller';
import { ResponsibilitiesService } from './responsibilities.service';
import { DelegatedWriteMembership } from '../auth/delegated-write.membership';
import { HolderScope } from '../common/holder-scope.service';
import { ObjectsModule } from '../objects/objects.module';

@Module({
  controllers: [ResponsibilitiesController],
  imports: [ObjectsModule],
  providers: [ResponsibilitiesService, DelegatedWriteMembership, HolderScope],
  exports: [ResponsibilitiesService],
})
export class ResponsibilitiesModule {}
