import { IsEnum, IsInt, IsOptional, IsPositive, IsString, MaxLength, ArrayNotEmpty, IsArray, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAssetRequestDto {
  @ApiPropertyOptional({ description: 'Who the asset is for; defaults to the requester' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  forUserId?: number;

  @ApiPropertyOptional({ description: 'Or the construction object the asset is for (permanent custody)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  forObjectId?: number;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  itemId: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(50)
  quantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class DecideAssetRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class IssueAssetRequestDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  assetIds: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class DirectIssueDto {
  @ApiProperty()
  @IsInt()
  @IsPositive()
  assetId: number;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  holderUserId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ObjectIssueDto {
  @ApiProperty()
  @IsInt()
  @IsPositive()
  assetId: number;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  objectId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ReassignCustodyDto {
  @ApiProperty({ description: "The person who now holds the asset on the object's behalf" })
  @IsInt()
  @IsPositive()
  holderUserId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export enum ReleaseCondition {
  OK = 'OK',
  DAMAGED = 'DAMAGED',
  LOST = 'LOST',
}

export class ReturnCustodyDto {
  @ApiProperty({ enum: ReleaseCondition })
  @IsEnum(ReleaseCondition)
  condition: ReleaseCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
