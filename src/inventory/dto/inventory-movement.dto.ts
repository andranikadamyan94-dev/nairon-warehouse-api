import { IsEnum, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';

export enum InventoryMovementType {
  IN = 'IN',
  OUT = 'OUT',
  ADJUSTMENT = 'ADJUSTMENT',
  RESERVATION = 'RESERVATION',
  RELEASE = 'RELEASE',
}

export class InventoryMovementDto {
  @IsInt()
  itemId: number;

  @IsNumber()
  quantity: number;

  @IsEnum(InventoryMovementType)
  type: InventoryMovementType;

  @IsOptional()
  @IsInt()
  taskId?: number;

  @IsOptional()
  @IsInt()
  supplierId?: number;

  @IsOptional()
  @IsInt()
  performedBy?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
