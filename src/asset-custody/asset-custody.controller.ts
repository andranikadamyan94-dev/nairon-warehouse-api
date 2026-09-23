import { Body, Controller, ForbiddenException, Get, Headers, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AssetCustodyService, PERM } from './asset-custody.service';
import { CreateAssetRequestDto, DecideAssetRequestDto, DirectIssueDto, IssueAssetRequestDto, ObjectIssueDto, ReassignCustodyDto, ReturnCustodyDto } from './dto/asset-custody.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { Public } from '../auth/decorators/public.decorator';
import { UsersPrismaService } from '../common/users-prisma.service';

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
  ) {}

  private async actor(req: any) {
    const userId = Number(req.user?.id);
    const info = await this.usersPrisma.getUserAccessInfo(userId, Number(req.headers?.['x-entity-id'] ?? 0) || undefined);
    return { userId, isSuperAdmin: !!info.isSuperAdmin, permissions: info.permissionNames ?? [] };
  }

  private entityOf(req: any): number | null {
    const n = Number(req.headers?.['x-entity-id'] ?? 0);
    return n > 0 ? n : null;
  }

  // ── requests ──
  @Post('asset-requests')
  @UseGuards(PermissionGuard)
  @Permissions(PERM.request, PERM.approve, PERM.issue)
  @ApiOperation({ summary: 'Ask for an asset with no end date (for yourself, or for someone if you may approve/issue)' })
  async createRequest(@Body() dto: CreateAssetRequestDto, @Req() req: any) {
    return this.service.createRequest(dto, await this.actor(req), this.entityOf(req));
  }

  @Get('asset-requests')
  @ApiOperation({ summary: 'Requests: the queue for approvers/issuers, your own otherwise' })
  async listRequests(@Query() q: any, @Req() req: any) {
    return this.service.listRequests({ status: q.status, forUserId: q.forUserId ? Number(q.forUserId) : undefined, mine: q.mine === '1' || q.mine === 'true' }, await this.actor(req));
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
  async forObject(@Param('objectId', ParseIntPipe) objectId: number) {
    return this.service.forObject(objectId);
  }

  @Get('custody')
  @ApiOperation({ summary: 'The custody register (filters: holderUserId, holderObjectId, assetId, open=1)' })
  async list(@Query() q: any, @Req() req: any) {
    return this.service.list({ holderUserId: q.holderUserId ? Number(q.holderUserId) : undefined, holderObjectId: q.holderObjectId ? Number(q.holderObjectId) : undefined, assetId: q.assetId ? Number(q.assetId) : undefined, open: q.open === '1' || q.open === 'true' }, await this.actor(req));
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
