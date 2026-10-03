import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { jwtConstants } from '../constants';
import { UsersPrismaService } from '../../common/users-prisma.service';
import { WarehouseActorService } from '../actor.service';
import { NOT_FOR_DELEGATED_KEY, delegatedForbidden, delegatedRefusal } from '../delegated-token.policy';
import { readOnlyForbidden, readOnlyRefused, routeKey } from '../read-only.policy';
import {
  DELEGATED_WRITE_ROUTE_KEY,
  DelegatedWriteRouteMeta,
  WriteTokenLedger,
  delegatedWriteCheck,
  delegatedWriteEnabled,
  delegatedWriteForbidden,
  isDelegatedWriteToken,
  missingWriteRight,
  writeTokenLedger,
} from '../delegated-write.policy';
import { DelegatedWriteMembership } from '../delegated-write.membership';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
    private usersPrisma: UsersPrismaService,
    private actors: WarehouseActorService,
    // Only a delegated WRITE token needs it; without it such a token is refused.
    @Optional() private writeMembership?: DelegatedWriteMembership,
    @Optional() private ledger: WriteTokenLedger = writeTokenLedger,
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

    // Delegated WRITE tokens (V3.4 standing approvals), with
    // DELEGATED_TOKENS_WRITE on: one tool's marked route, re-checked here.
    // Flag off, they fall to the read-only rule below, which refuses them.
    if (isDelegatedWriteToken(request['user']) && delegatedWriteEnabled()) {
      await this.admitDelegatedWrite(context, request);
      return true;
    }

    // Delegated AI tokens (carrying `act`): GET only, with X-Entity-ID equal
    // to the token's organisation — required here, because without it the
    // actor counts the person's grants from every organisation — and never on
    // a GET that writes. Always null for a normal token. See
    // delegated-token.policy.ts. ai-api calls this service directly, so the
    // gateway's copy of the rule does not bind it.
    const refusal = delegatedRefusal(request['user'], {
      method: request.method,
      entityHeader: request.headers?.['x-entity-id'],
      routeRefused: !!this.reflector.getAllAndOverride<boolean>(NOT_FOR_DELEGATED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]),
    });
    if (refusal) throw delegatedForbidden(refusal);

    // Who they are and where they are acting, resolved once, from the users
    // database rather than from anything the caller sent. Done here because
    // this guard is global and runs first: PermissionGuard then reads the
    // result instead of asking again, and handlers get it through @Actor().
    // A workspace claim the caller has no role in is refused in here.
    request['actor'] = await this.actors.resolve(request);

    // Read-only super administrator (read-only.policy.ts): the actor sees
    // whatever its flags open and is refused every writing method — here, in
    // the one guard every route runs, before PermissionGuard's super-admin
    // bypass. Exposed on the request the way PermissionGuard exposes isSuperAdmin.
    request.readOnly = request['actor'].readOnly;
    if (readOnlyRefused(request['actor'].readOnly, request.method, routeKey(context))) throw readOnlyForbidden();

    return true;
  }

  /**
   * delegated-write.policy.ts, in order: the token against this route, then
   * the organisation (HR over the internal channel — never the token, which
   * hr-api refuses), then the actor in exactly that organisation and its
   * rights there, literally, then one mutation per token. Any "no" is a 403.
   */
  private async admitDelegatedWrite(context: ExecutionContext, request: any): Promise<void> {
    const route = this.reflector.getAllAndOverride<DelegatedWriteRouteMeta>(DELEGATED_WRITE_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const grant = delegatedWriteCheck(request['user'], {
      method: request.method,
      entityHeader: request.headers?.['x-entity-id'],
      route,
      params: request.params,
      body: request.body,
    });
    if (typeof grant === 'string') throw delegatedWriteForbidden(grant);

    if (!this.writeMembership) throw delegatedWriteForbidden('not_a_member');
    if (!(await this.writeMembership.isMember(grant.entityId, grant.userId))) {
      throw delegatedWriteForbidden('not_a_member');
    }
    // Read by WarehouseActorService: HR has just said this person is in exactly this entity.
    request.delegatedWrite = grant;

    // The actor, declared in the token's organisation (X-Entity-ID was checked
    // equal to it above); its permissions are that organisation's only.
    const actor = await this.actors.resolve(request);
    if (actor.declared !== grant.entityId) throw delegatedWriteForbidden('entity_mismatch');
    // The person the token acts for cannot write; neither can the token.
    if (actor.readOnly) throw readOnlyForbidden();
    if (missingWriteRight(grant.tool, actor.permissionNames)) throw delegatedWriteForbidden('missing_permission');

    if (grant.kind === 'mutation' && !this.ledger.spend(request['user'].jti, request['user'].exp)) {
      throw delegatedWriteForbidden('token_already_used');
    }
    request['actor'] = actor;
  }

  private extractTokenFromHeader(
    request: Request & { headers: { authorization: string } },
  ): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
