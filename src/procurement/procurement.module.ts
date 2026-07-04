import { Module } from '@nestjs/common';
import { ProcurementService } from './procurement.service';
import { ProcurementController } from './procurement.controller';
import { FileService } from '../common/file.service';

@Module({
  controllers: [ProcurementController],
  providers: [ProcurementService, FileService],
})
export class ProcurementModule {}
