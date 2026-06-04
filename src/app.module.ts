import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggingMiddleware } from './common/middleware/logging.middleware';

import { PrismaModule } from 'prisma/prisma.module';

import { AuthModule } from './auth/auth.module';
import { EntitiesModule } from './entities/entities.module';
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
import { SuppliersModule } from './suppliers/suppliers.module';
import { ProcurementModule } from './procurement/procurement.module';
import { ResourceReturnsModule } from './resource-returns/resource-returns.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    PrismaModule,

    AuthModule,
    EntitiesModule,
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
    SuppliersModule,
    ProcurementModule,
    ResourceReturnsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggingMiddleware).forRoutes('*');
  }
}
