import { Module } from '@nestjs/common';
import { ProcurementService } from './procurement.service';
import { ProcurementController } from './procurement.controller';

@Module({
  controllers: [ProcurementController],
  providers: [ProcurementService],
})
export class ProcurementModule {}
