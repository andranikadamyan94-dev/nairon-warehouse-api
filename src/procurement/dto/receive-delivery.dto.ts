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
}
