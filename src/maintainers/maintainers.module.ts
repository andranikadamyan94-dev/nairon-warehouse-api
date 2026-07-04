import { Module } from '@nestjs/common';
import { MaintainersController } from './maintainers.controller';
import { MaintainersService } from './maintainers.service';

@Module({
  controllers: [MaintainersController],
  providers: [MaintainersService],
})
export class MaintainersModule {}
