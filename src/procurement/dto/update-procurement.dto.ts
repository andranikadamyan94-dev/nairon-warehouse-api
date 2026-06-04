import { PartialType } from '@nestjs/swagger';
import { CreateProcurementDto } from './create-procurement.dto';

export class UpdateProcurementDto extends PartialType(CreateProcurementDto) {}
