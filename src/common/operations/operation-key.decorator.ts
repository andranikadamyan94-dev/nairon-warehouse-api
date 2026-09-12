import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * The caller's `Idempotency-Key`, if it sent one.
 *
 * Optional everywhere on purpose. A route that takes this keeps working for
 * every client that has never heard of the header — which today is all of
 * them except the assistant — and gains exactly-once behaviour for the ones
 * that do send it. The key is opaque: this service never parses it, derives
 * nothing from it, and grants nothing because of it.
 */
export const OperationKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const raw = ctx.switchToHttp().getRequest().headers?.['idempotency-key'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  },
);
