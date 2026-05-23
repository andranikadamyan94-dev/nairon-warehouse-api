import { IsInt, IsOptional, IsString } from 'class-validator';

export class AssignResponsibilityDto {
  @IsInt()
  assetId: number;

  @IsInt()
  userId: number;

  @IsOptional()
  @IsInt()
  assignedBy?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
