import { IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Submitting a job for finance approval.
 *
 * This was an untyped body, which meant a negative deposit was silently
 * ignored — it fell through the `> 0` branch and raised a full transfer with no
 * deposit and no explanation. Validated here so the request is refused with a
 * message instead.
 */
export class FinalizeMaintenanceDto {
  @ApiProperty()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  /** Deposit the maintainer wants before starting; never more than the job. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  prepaymentAmount?: number;
}
