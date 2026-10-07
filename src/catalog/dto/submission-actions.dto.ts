import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Line ids are `r<reservationId>` / `l<requisitionLineId>` — see catalog.rules.ts. */
export class EditLineDto {
  @ApiProperty()
  @IsString({ message: 'Տողը նշված չէ' })
  @IsNotEmpty({ message: 'Տողը նշված չէ' })
  id: string;

  @ApiProperty()
  @IsNumber({}, { message: 'Քանակը պետք է լինի թիվ' })
  @IsPositive({ message: 'Քանակը պետք է լինի դրական թիվ' })
  quantity: number;
}

/** PATCH /catalog/submissions/:id — the requester, while nothing is approved (D7). */
export class EditSubmissionDto {
  @ApiPropertyOptional({ type: [EditLineDto] })
  @IsOptional()
  @IsArray({ message: 'Տողերի ցանկը սխալ է' })
  @ArrayMaxSize(200, { message: 'Չափազանց շատ տողեր' })
  @ValidateNested({ each: true })
  @Type(() => EditLineDto)
  lines?: EditLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Նպատակը պետք է լինի տեքստ' })
  @IsNotEmpty({ message: 'Նշեք, թե ինչու է անհրաժեշտ' })
  @MaxLength(4000, { message: 'Նպատակը չափազանց երկար է' })
  purpose?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({}, { message: 'Ամսաթիվը սխալ է' })
  neededBy?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Մեկնաբանությունը պետք է լինի տեքստ' })
  @MaxLength(4000, { message: 'Մեկնաբանությունը չափազանց երկար է' })
  comment?: string;
}

export class ApproveLineDto {
  @ApiProperty()
  @IsString({ message: 'Տողը նշված չէ' })
  @IsNotEmpty({ message: 'Տողը նշված չէ' })
  id: string;

  /** 0 rejects the line; below the asked quantity is a partial approval. */
  @ApiProperty()
  @IsNumber({}, { message: 'Հաստատվող քանակը պետք է լինի թիվ' })
  @Min(0, { message: 'Հաստատվող քանակը չի կարող բացասական լինել' })
  approvedQuantity: number;

  /** Asset lines (REQ-1015): the units handed out — as many as approvedQuantity less those already out. */
  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray({ message: 'Միավորների ցանկը սխալ է' })
  @ArrayMaxSize(500, { message: 'Չափազանց շատ միավորներ' })
  @IsInt({ each: true, message: 'Միավորը նշված չէ' })
  assetIds?: number[];
}

/** PATCH /catalog/submissions/:id/approve — full or partial, per line. */
export class ApproveSubmissionDto {
  @ApiProperty({ type: [ApproveLineDto] })
  @IsArray({ message: 'Տողերի ցանկը սխալ է' })
  @ArrayMinSize(1, { message: 'Նշեք գոնե մեկ տող' })
  @ArrayMaxSize(200, { message: 'Չափազանց շատ տողեր' })
  @ValidateNested({ each: true })
  @Type(() => ApproveLineDto)
  lines: ApproveLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Մեկնաբանությունը պետք է լինի տեքստ' })
  @MaxLength(4000, { message: 'Մեկնաբանությունը չափազանց երկար է' })
  comment?: string;
}

/** PATCH /catalog/submissions/:id/reject — the reason is required. */
export class RejectSubmissionDto {
  @ApiProperty()
  @IsString({ message: 'Մերժման պատճառը պարտադիր է' })
  @IsNotEmpty({ message: 'Մերժման պատճառը պարտադիր է' })
  @MaxLength(4000, { message: 'Պատճառը չափազանց երկար է' })
  reason: string;
}

/** PATCH /catalog/submissions/:id/return and POST …/reply — a text. */
export class SubmissionTextDto {
  @ApiProperty()
  @IsString({ message: 'Տեքստը պարտադիր է' })
  @IsNotEmpty({ message: 'Տեքստը պարտադիր է' })
  @MaxLength(4000, { message: 'Տեքստը չափազանց երկար է' })
  text: string;
}
