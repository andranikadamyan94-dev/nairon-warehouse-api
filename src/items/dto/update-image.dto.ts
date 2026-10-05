import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

/** PATCH /items/:id/images/:imageId — make it the cover and/or move it. */
export class UpdateImageDto {
  @ApiPropertyOptional({ description: 'true makes this image the cover (the previous cover steps down)' })
  @IsOptional()
  @IsBoolean()
  isCover?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}
