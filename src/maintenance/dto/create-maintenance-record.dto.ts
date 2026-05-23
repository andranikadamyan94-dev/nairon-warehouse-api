import { IsDateString, IsInt, IsOptional, IsString } from 'class-validator';

export class CreateMaintenanceRecordDto {
  @IsInt()
  assetId: number;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsInt()
  createdBy?: number;
}
