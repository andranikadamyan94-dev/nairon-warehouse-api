import { Module } from '@nestjs/common';
import { AssetCustodyController } from './asset-custody.controller';
import { AssetCustodyService } from './asset-custody.service';

@Module({
  controllers: [AssetCustodyController],
  providers: [AssetCustodyService],
  exports: [AssetCustodyService],
})
export class AssetCustodyModule {}
