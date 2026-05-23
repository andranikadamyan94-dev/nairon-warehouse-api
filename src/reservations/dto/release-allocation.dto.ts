import { IsInt, IsOptional, IsString } from 'class-validator';

export class ReleaseAllocationDto {
  @IsInt()
  allocationId: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
