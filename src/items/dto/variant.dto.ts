import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';

/** POST /items/:id/variants — a child item; name, type, unit and category come from the parent. */
export class CreateVariantDto {
  @ApiProperty({ description: '«Գրաֆիտ», «Բաց մոխրագույն» …' })
  @IsString()
  @IsNotEmpty()
  variantLabel: string;

  @ApiPropertyOptional({ description: 'Own code; generated (RES-######) when omitted' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  code?: string | null;
}

/** PATCH /items/:id/variants/:variantId */
export class UpdateVariantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  variantLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  code?: string | null;
}
