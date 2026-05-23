import { Body, Controller, Post } from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AvailabilityService } from './availability.service';

import { CheckAvailabilityDto } from './dto/check-availability.dto';

@ApiTags('Availability')
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  @Post('check')
  @ApiOperation({
    summary: 'Check resource availability',
  })
  @ApiResponse({
    status: 200,
  })
  checkAvailability(
    @Body()
    dto: CheckAvailabilityDto,
  ) {
    return this.availabilityService.checkAvailability(dto);
  }
}
