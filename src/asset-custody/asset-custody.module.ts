import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { AssetCustodyController } from './asset-custody.controller';
import { AssetCustodyService } from './asset-custody.service';
import { HolderScope } from '../common/holder-scope.service';
import { DelegatedWriteMembership } from '../auth/delegated-write.membership';

@Module({
  imports: [ObjectsModule],
  controllers: [AssetCustodyController],
  providers: [AssetCustodyService, HolderScope, DelegatedWriteMembership],
  exports: [AssetCustodyService],
})
export class AssetCustodyModule {}
