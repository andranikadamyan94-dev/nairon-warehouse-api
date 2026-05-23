import { IsInt, IsOptional, IsString } from 'class-validator';

export class ReallocateResourceDto {
  @IsInt()
  allocationId: number;

  @IsInt()
  newAssetId: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
