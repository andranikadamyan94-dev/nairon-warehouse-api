import { Module } from '@nestjs/common';
import { ResourceReturnsController } from './resource-returns.controller';
import { ResourceReturnsService } from './resource-returns.service';

@Module({
  controllers: [ResourceReturnsController],
  providers: [ResourceReturnsService],
})
export class ResourceReturnsModule {}
