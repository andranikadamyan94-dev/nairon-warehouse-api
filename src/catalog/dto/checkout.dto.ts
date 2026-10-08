import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One cart line: a variant (child item) or a parent that has no variants. */
export class CheckoutLineDto {
  @ApiProperty()
  @IsInt({ message: 'Ապրանքը նշված չէ' })
  itemId: number;

  @ApiProperty()
  @IsNumber({}, { message: 'Քանակը պետք է լինի թիվ' })
  @IsPositive({ message: 'Քանակը պետք է լինի դրական թիվ' })
  quantity: number;
}

/** «Նոր ապրանք» — an item the warehouse does not have yet (D2). */
export class CheckoutNewItemDto {
  @ApiProperty()
  @IsString({ message: 'Նշեք ապրանքի անվանումը' })
  @IsNotEmpty({ message: 'Նշեք ապրանքի անվանումը' })
  @MaxLength(300, { message: 'Անվանումը չափազանց երկար է' })
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Բրենդ/մոդելը պետք է լինի տեքստ' })
  @MaxLength(300, { message: 'Բրենդ/մոդելը չափազանց երկար է' })
  brandModel?: string;

  @ApiProperty()
  @IsNumber({}, { message: 'Քանակը պետք է լինի թիվ' })
  @IsPositive({ message: 'Քանակը պետք է լինի դրական թիվ' })
  quantity: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Հղումը պետք է լինի տեքստ' })
  @MaxLength(2000, { message: 'Հղումը չափազանց երկար է' })
  link?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Նկարագրությունը պետք է լինի տեքստ' })
  @MaxLength(4000, { message: 'Նկարագրությունը չափազանց երկար է' })
  description?: string;
}

export class CheckoutDto {
  @ApiPropertyOptional({ type: [CheckoutLineDto] })
  @IsOptional()
  @IsArray({ message: 'Ապրանքների ցանկը սխալ է' })
  @ArrayMaxSize(200, { message: 'Մեկ հարցման մեջ չափազանց շատ տողեր են' })
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineDto)
  lines?: CheckoutLineDto[];

  @ApiPropertyOptional({ type: [CheckoutNewItemDto] })
  @IsOptional()
  @IsArray({ message: 'Նոր ապրանքների ցանկը սխալ է' })
  @ArrayMaxSize(200, { message: 'Մեկ հարցման մեջ չափազանց շատ տողեր են' })
  @ValidateNested({ each: true })
  @Type(() => CheckoutNewItemDto)
  newItems?: CheckoutNewItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt({ message: 'Նախագիծը սխալ է նշված' })
  projectId?: number;

  /**
   * Object requests (2026-10-08): the CRM construction object the goods are
   * for. Only the object's responsible person (or manage_reservations / a
   * super admin) may name it; the project is then the object's own.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt({ message: 'Օբյեկտը սխալ է նշված' })
  objectId?: number;

  /**
   * Task requests (2026-10-08): the CRM task the goods are for. One of the
   * task's people (its creator or a role slot) — or manage_reservations / a
   * super admin — may name it; the project is then the task's own and the
   * object the task's, so the rows follow the task rules (receipt by the task
   * roles, the «Կատարված» gate, costs on the object).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt({ message: 'Առաջադրանքը սխալ է նշված' })
  taskId?: number;

  /** The project's name as the picker showed it — a label for the rows, never authority. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Նախագծի անվանումը պետք է լինի տեքստ' })
  @MaxLength(300, { message: 'Նախագծի անվանումը չափազանց երկար է' })
  projectName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Ծախսային կենտրոնը պետք է լինի տեքստ' })
  @MaxLength(300, { message: 'Ծախսային կենտրոնը չափազանց երկար է' })
  costCenter?: string;

  @ApiProperty()
  @IsString({ message: 'Նշեք, թե ինչու է անհրաժեշտ' })
  @IsNotEmpty({ message: 'Նշեք, թե ինչու է անհրաժեշտ' })
  @MaxLength(4000, { message: 'Նպատակը չափազանց երկար է' })
  purpose: string;

  @ApiProperty()
  @IsDateString({}, { message: 'Նշեք, թե երբ է անհրաժեշտ' })
  neededBy: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Մեկնաբանությունը պետք է լինի տեքստ' })
  @MaxLength(4000, { message: 'Մեկնաբանությունը չափազանց երկար է' })
  comment?: string;
}
