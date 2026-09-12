import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsInt, IsOptional } from 'class-validator';

import { CreateMaintenanceRecordDto } from './create-maintenance-record.dto';

/**
 * What a maintenance edit may contain.
 *
 * The route took `@Body() dto: any` — no validation at all, so a malformed date
 * or a string where a number belongs reached Prisma and failed there, and
 * anything else in the body rode along unexamined.
 *
 * `createdBy` is left out entirely: the author is whoever holds the token, not
 * a number in the body.
 *
 * `assetId` is accepted but may only repeat what the record already says. The
 * client's edit form sends it back unchanged on every save, so refusing the
 * field would answer 400 to a screen that has worked for months — and honouring
 * a change would move the record between assets, which can move it between
 * companies. Naming a different one is refused in words rather than dropped in
 * silence; the service does that, because only it knows the current asset.
 */
export class UpdateMaintenanceRecordDto extends PartialType(
  OmitType(CreateMaintenanceRecordDto, ['assetId', 'createdBy'] as const),
) {
  @ApiPropertyOptional({ description: 'Must match the record’s current asset.' })
  @IsOptional()
  @IsInt()
  assetId?: number;
}
