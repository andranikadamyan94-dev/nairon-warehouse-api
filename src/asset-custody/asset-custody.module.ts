import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { AssetCustodyController } from './asset-custody.controller';
import { AssetCustodyService } from './asset-custody.service';

@Module({
  imports: [ObjectsModule],
  controllers: [AssetCustodyController],
  providers: [AssetCustodyService],
  exports: [AssetCustodyService],
})
export class AssetCustodyModule {}
