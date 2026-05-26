import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from 'prisma/prisma.module';

import { ItemsModule } from './items/items.module';
import { AssetsModule } from './assets/assets.module';
import { InventoryModule } from './inventory/inventory.module';
import { ReservationsModule } from './reservations/reservations.module';
import { AvailabilityModule } from './availability/availability.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { ResponsibilitiesModule } from './responsibilities/responsibilities.module';
import { AllocationsModule } from './allocations/allocations.module';
import { UsersModule } from './users/users.module';
import { CategoriesModule } from './categories/categories.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    PrismaModule,

    ItemsModule,
    AssetsModule,
    InventoryModule,
    ReservationsModule,
    AvailabilityModule,
    MaintenanceModule,
    ResponsibilitiesModule,
    AllocationsModule,
    UsersModule,
    CategoriesModule,
  ],
})
export class AppModule {}
