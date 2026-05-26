import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsInt, IsOptional } from 'class-validator';

export class GetItemsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  categoryId?: number;
}
