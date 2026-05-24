import { Module } from '@nestjs/common';

import { AllocationsController } from './allocations.controller';
import { AllocationsService } from './allocations.service';

import { PrismaModule } from 'prisma/prisma.module';

@Module({
  imports: [PrismaModule],

  controllers: [AllocationsController],

  providers: [AllocationsService],

  exports: [AllocationsService],
})
export class AllocationsModule {}
