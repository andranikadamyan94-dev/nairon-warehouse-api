import { Body, Controller, ForbiddenException, Get, Headers, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AssetCustodyService, PERM, ReadScope } from './asset-custody.service';
import { CreateAssetRequestDto, DecideAssetRequestDto, DirectIssueDto, IssueAssetRequestDto, ObjectIssueDto, ReassignCustodyDto, ReturnCustodyDto } from './dto/asset-custody.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { Public } from '../auth/decorators/public.decorator';
import { accessWorkspace, readDeclaredWorkspace } from '../auth/actor';
import { isDelegatedToken } from '../auth/delegated-token.policy';
import { UsersPrismaService } from '../common/users-prisma.service';
import { OperationsService } from '../common/operations/operations.service';
import { OperationKey } from '../common/operations/operation-key.decorator';
import { PREFLIGHT_OK } from '../common/preflight/preflight';

/**
 * Personal asset issue (no end date) and the custody register. Objects as
 * holders and task-allocation custody come in the next phases.
 */
@ApiTags('Asset custody')
@Controller()
export class AssetCustodyController {
  constructor(
    private readonly service: AssetCustodyService,
    private readonly usersPrisma: UsersPrismaService,
    private readonly operations: OperationsService,
  ) {}

  /**
   * Custody rights, resolved the way WarehouseActorService resolves the actor's
   * ("the warehouse is global", 2026-10-05): across every organisation for a
   * session, whatever the browser has selected; in its own one for a delegated
   * AI token, whose header AuthGuard has already held to it.
   */
  private async actor(req: any) {
    const userId = Number(req.user?.id);
    const resolveIn = accessWorkspace(isDelegatedToken(req.user), readDeclaredWorkspace(req.headers?.['x-entity-id']));
    const info = await this.usersPrisma.getUserAccessInfo(userId, resolveIn);
    return { userId, isSuperAdmin: !!info.isSuperAdmin, permissions: info.permissionNames ?? [] };
  }

  /** The organisation as AuthGuard verified it (request.actor), and the caller's token for CRM. */
  private scopeOf(req: any): ReadScope {
    const auth = req.headers?.authorization;
    return {
      declared: req.actor?.declared ?? null,
      authorization: typeof auth === 'string' ? auth : undefined,
    };
  }

  private entityOf(req: any): number | null {
    const n = Number(req.headers?.['x-entity-id'] ?? 0);
    return n > 0 ? n : null;
  }

  // ── requests ──
  /** 2026-09-29: an object asks for assets — only its responsible person (the service checks CRM), no request permission needed. */
  @Post('asset-requests/object/:objectId')
  @ApiOperation({ summary: 'Ask for assets for a construction object (its responsible person)' })
  async createObjectRequest(@Param('objectId', ParseIntPipe) objectId: number, @Body() dto: CreateAssetRequestDto, @Req() req: any) {
    return this.service.createRequest({ ...dto, forObjectId: objectId, forUserId: undefined }, await this.actor(req), this.entityOf(req));
  }

  @Post('asset-requests')
  @UseGuards(PermissionGuard)
  @Permissions(PERM.request, PERM.approve, PERM.issue)
  @ApiOperation({ summary: 'Ask for an asset with no end date (for yourself, or for someone if you may approve/issue)' })
  async createRequest(
    @Body() dto: CreateAssetRequestDto,
    @Req() req: any,
    /* Asking twice files two requests. See OperationsService. */
    @OperationKey() operationKey?: string,
  ) {
    const actor = await this.actor(req);
    const { result, replayed } = await this.operations.runOnce(
      { key: operationKey, actor: req.actor, route: 'POST /asset-requests', body: dto },
      (tx) => this.service.fileRequest(dto, actor, this.entityOf(req), tx),
    );
    // Approvers hear of it once, after it committed — never again on a replay.
    if (!replayed) this.service.announceRequest(result);
    return result;
  }

  /*
   * The assistant's preflights (2026-10-01, coverage gaps batch 4) — see
   * src/common/preflight/preflight.ts and the service's previewRequest /
   * previewCancelRequest. Each sits beside its mutation behind the same guard
   * (create: the request rights; cancel: none, the service is the gate), takes
   * the mutation's own body, writes nothing and notifies nobody.
   */
  @Post('asset-requests/preflight/create')
  @UseGuards(PermissionGuard)
  @Permissions(PERM.request, PERM.approve, PERM.issue)
  @ApiOperation({ summary: 'Preflight: may this person ask for this asset for themselves, and what would it be?' })
  async preflightCreateRequest(@Body() dto: CreateAssetRequestDto, @Req() req: any) {
    return { ...PREFLIGHT_OK, ...(await this.service.previewRequest(dto, await this.actor(req), this.entityOf(req))) };
  }

  @Post('asset-requests/:id/preflight/cancel')
  @ApiOperation({ summary: 'Preflight: may this person withdraw their own asset request?' })
  async preflightCancelRequest(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return { ...PREFLIGHT_OK, ...(await this.service.previewCancelRequest(id, await this.actor(req), this.entityOf(req))) };
  }

  @Get('asset-requests')
  @ApiOperation({ summary: 'Requests: the queue for approvers/issuers, your own otherwise' })
  async listRequests(@Query() q: any, @Req() req: any) {
    return this.service.listRequests({ status: q.status, forUserId: q.forUserId ? Number(q.forUserId) : undefined, forObjectId: q.forObjectId ? Number(q.forObjectId) : undefined, mine: q.mine === '1' || q.mine === 'true' }, await this.actor(req));
  }

  @Patch('asset-requests/:id/approve')
  @UseGuards(PermissionGuard)
  @Permissions(PERM.approve)
  async approve(@Param('id', ParseIntPipe) id: number, @Body() dto: DecideAssetRequestDto, @Req() req: any) {
    return this.service.decide(id, true, dto.note, await this.actor(req));
  }

  @Patch('asset-requests/:id/reject')
  @UseGuards(PermissionGuard)
  @Permissions(PERM.approve)
  async reject(@Param('id', ParseIntPipe) id: number, @Body() dto: DecideAssetRequestDto, @Req() req: any) {
    return this.service.decide(id, false, dto.note, await this.actor(req));
  }

  @Patch('asset-requests/:id/cancel')
  async cancel(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.cancel(id, await this.actor(req));
  }

  @Post('asset-requests/:id/issue')
  @UseGuards(PermissionGuard)
  @Permissions(PERM.issue)
  @ApiOperation({ summary: 'Hand out concrete assets against an approved request' })
  async issue(@Param('id', ParseIntPipe) id: number, @Body() dto: IssueAssetRequestDto, @Req() req: any) {
    return this.service.issue(id, dto, await this.actor(req));
  }

  // ── custody ──
  @Post('custody')
  @UseGuards(PermissionGuard)
  @Permissions(PERM.issue)
  @ApiOperation({ summary: 'Hand an asset to a person directly (no request)' })
  async directIssue(@Body() dto: DirectIssueDto, @Req() req: any) {
    return this.service.directIssue(dto, await this.actor(req));
  }

  @Post('custody/object')
  @UseGuards(PermissionGuard)
  @Permissions(PERM.issue)
  @ApiOperation({ summary: 'Give an asset to a construction object (permanent; no return to the warehouse)' })
  async issueToObject(@Body() dto: ObjectIssueDto, @Req() req: any) {
    return this.service.directIssueToObject(dto, await this.actor(req));
  }

  @Post('custody/:id/reassign')
  @ApiOperation({ summary: "Hand an object's asset to a person (the object's responsible or the warehouse)" })
  async reassign(@Param('id', ParseIntPipe) id: number, @Body() dto: ReassignCustodyDto, @Req() req: any) {
    return this.service.reassign(id, dto, await this.actor(req));
  }

  @Get('custody/object/:objectId')
  @ApiOperation({ summary: 'What an object holds and held' })
  async forObject(@Param('objectId', ParseIntPipe) objectId: number, @Req() req: any) {
    return this.service.forObject(objectId, await this.actor(req), this.scopeOf(req));
  }

  @Get('custody')
  @ApiOperation({ summary: 'The custody register (filters: holderUserId, holderObjectId, assetId, open=1)' })
  async list(@Query() q: any, @Req() req: any) {
    return this.service.list({ holderUserId: q.holderUserId ? Number(q.holderUserId) : undefined, holderObjectId: q.holderObjectId ? Number(q.holderObjectId) : undefined, assetId: q.assetId ? Number(q.assetId) : undefined, open: q.open === '1' || q.open === 'true' }, await this.actor(req), this.scopeOf(req));
  }

  @Get('custody/mine')
  @ApiOperation({ summary: 'What I hold, and what I held' })
  async mine(@Req() req: any) {
    const actor = await this.actor(req);
    return this.service.list({ holderUserId: actor.userId }, actor);
  }

  @Get('custody/user/:userId/open/internal')
  @Public()
  @ApiOperation({ summary: 'Internal: what a person still holds (HR asks before a deactivation)' })
  async openInternal(@Param('userId', ParseIntPipe) userId: number, @Headers('x-internal-secret') secret: string) {
    if (!secret || secret !== process.env.INTERNAL_SECRET) throw new ForbiddenException();
    return this.service.openForUser(userId);
  }

  @Patch('custody/:id/accept')
  @ApiOperation({ summary: 'The holder confirms receipt' })
  async accept(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.accept(id, await this.actor(req));
  }

  @Patch('custody/:id/return')
  @ApiOperation({ summary: 'Return the asset with its condition (holder or warehouse)' })
  async release(@Param('id', ParseIntPipe) id: number, @Body() dto: ReturnCustodyDto, @Req() req: any) {
    return this.service.release(id, dto, await this.actor(req));
  }
}
