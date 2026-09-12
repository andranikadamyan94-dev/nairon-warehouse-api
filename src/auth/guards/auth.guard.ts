import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { jwtConstants } from '../constants';
import { UsersPrismaService } from '../../common/users-prisma.service';
import { WarehouseActorService } from '../actor.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
    private usersPrisma: UsersPrismaService,
    private actors: WarehouseActorService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) throw new UnauthorizedException();

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: jwtConstants.secret,
      });
      request['user'] = payload;
    } catch {
      throw new UnauthorizedException();
    }

    // The signature says the token was ours; it does not say the account still
    // exists. Tokens run for 30 days with no session store, so a deactivated
    // person keeps a valid one — checked here rather than in PermissionGuard
    // because that one returns early on routes with no required permission.
    if (await this.usersPrisma.isDeactivated(request['user'].id)) {
      throw new UnauthorizedException('Այս հաշիվը ապաակտիվացված է');
    }

    // Who they are and where they are acting, resolved once, from the users
    // database rather than from anything the caller sent. Done here because
    // this guard is global and runs first: PermissionGuard then reads the
    // result instead of asking again, and handlers get it through @Actor().
    // A workspace claim the caller has no role in is refused in here.
    request['actor'] = await this.actors.resolve(request);

    return true;
  }

  private extractTokenFromHeader(
    request: Request & { headers: { authorization: string } },
  ): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
