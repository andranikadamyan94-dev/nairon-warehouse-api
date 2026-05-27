import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const { method, originalUrl } = req;
    const start = Date.now();

    res.on('finish', () => {
      const ms = Date.now() - start;
      const { statusCode } = res;
      const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'log';

      const body =
        ['POST', 'PATCH', 'PUT'].includes(method) && req.body
          ? ` | body: ${JSON.stringify(req.body)}`
          : '';

      this.logger[level](`${method} ${originalUrl}${body} → ${statusCode} (${ms}ms)`);
    });

    next();
  }
}
