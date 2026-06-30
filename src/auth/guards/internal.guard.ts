import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';

@Injectable()
export class InternalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const key = request.headers['x-internal-secret'];
    if (!key || key !== process.env.INTERNAL_SECRET) {
      throw new ForbiddenException('Invalid internal service key');
    }
    return true;
  }
}
