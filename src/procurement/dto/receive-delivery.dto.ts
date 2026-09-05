import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ReceiveDeliveryLineDto {
  @IsInt()
  @Type(() => Number)
  orderItemId: number;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  quantity: number;
}

export class ReceiveDeliveryDto {
  @ApiPropertyOptional({
    type: [ReceiveDeliveryLineDto],
    description:
      'What actually arrived, per order line. Omit to receive the entire outstanding remainder.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiveDeliveryLineDto)
  lines?: ReceiveDeliveryLineDto[];

  @ApiPropertyOptional({ description: 'Free-text note about this delivery.' })
  @IsOptional()
  @IsString()
  notes?: string;

  // Required in practice — the service rejects a blank one. Kept optional at
  // the DTO level because multipart bodies bypass this class anyway (the
  // controller assembles the DTO from strings) and the service owns the
  // Armenian error message.
  @ApiPropertyOptional({ description: 'Invoice/waybill № of the accompanying document. Required.' })
  @IsOptional()
  @IsString()
  documentNumber?: string;
}
