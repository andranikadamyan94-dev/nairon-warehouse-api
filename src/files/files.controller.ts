import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { jwtConstants } from '../auth/constants';
import { UsersPrismaService } from '../common/users-prisma.service';
import { FileRequester, requestToken, sendStoredFile } from '../common/stored-files';
import { FilesService } from './files.service';

/**
 * Receipts, answered by asking.
 *
 * Reached as `/api/uploads/<name>`, and as the bare `/uploads/<name>` that
 * `main.ts` rewrites onto it — the two prefixes the static mounts used to
 * answer — so every stored path keeps resolving for the people who may read
 * it, and for nobody else.
 *
 * `@Public` only in the sense that the global AuthGuard reads a Bearer header
 * and an `<img>` cannot send one. This route authenticates itself, header or
 * session cookie, and refuses anyone without a credential.
 */
@Public()
@Controller('uploads')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly jwt: JwtService,
    private readonly usersPrisma: UsersPrismaService,
  ) {}

  @Get(':name')
  async upload(@Param('name') name: string, @Req() req: Request, @Res() res: Response) {
    const who = await this.who(req);
    if (!who) return res.status(401).send('Unauthorized');
    const file = await this.files.upload(name, who);
    if (!file) return res.status(404).send('Not found');
    sendStoredFile(res, file);
  }

  private async who(req: Request): Promise<FileRequester | null> {
    const token = requestToken(req);
    if (!token) return null;
    try {
      const payload: { id?: unknown } = await this.jwt.verifyAsync(token, {
        secret: jwtConstants.secret,
      });
      const userId = Number(payload?.id);
      if (!Number.isInteger(userId) || userId <= 0) return null;
      if (await this.usersPrisma.isDeactivated(userId)) return null;
      return { userId, authorization: `Bearer ${token}` };
    } catch {
      return null;
    }
  }
}
