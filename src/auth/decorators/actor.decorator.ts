import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { WarehouseActor } from '../actor';

/**
 * The trusted actor for this request, put there by AuthGuard.
 *
 * A handler that takes this is saying it needs to know who is asking and where
 * — which, in a service that until now passed nothing but a DTO into its
 * mutations, is most of the point of the exercise.
 */
export const Actor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WarehouseActor => {
    return ctx.switchToHttp().getRequest().actor;
  },
);
