import { PartialType } from '@nestjs/mapped-types';
import { CreateMaintainerDto } from './create-maintainer.dto';

export class UpdateMaintainerDto extends PartialType(CreateMaintainerDto) {}
