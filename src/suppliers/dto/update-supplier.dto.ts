import { PartialType } from '@nestjs/swagger';
import { CreateSupplierDto } from './create-supplier.dto';

/**
 * Every field optional, every rule inherited (#2514): a `name` that is sent
 * is still trimmed and must be non-empty; an `email` that is sent is trimmed,
 * dropped when blank, and must be valid otherwise.
 */
export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}
