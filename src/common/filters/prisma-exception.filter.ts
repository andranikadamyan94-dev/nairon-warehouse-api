import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

/**
 * Turns Prisma's known request errors into meaningful HTTP responses.
 *
 * Without this a broken unique constraint surfaces as a bare 500 with no body,
 * so the UI can only show a generic failure — the user is never told that, say,
 * the code they typed is already taken.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  /**
   * The field(s) that tripped the constraint. Prisma reports these in
   * `meta.target`, either as an array of column names or as the raw index name
   * ("Item_code_key"), which we trim back to the column.
   */
  private fields(exception: Prisma.PrismaClientKnownRequestError): string[] {
    const target = (exception.meta as { target?: string[] | string } | undefined)?.target;
    if (Array.isArray(target)) return target;
    if (typeof target === 'string') {
      // "Item_code_key" → "code"; leave anything unexpected as-is.
      const m = target.match(/^[A-Za-z]+_(.+)_key$/);
      return [m ? m[1] : target];
    }
    return [];
  }

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.BAD_REQUEST;
    let message = 'Հարցումը սխալ է';
    // Returned alongside the message so a form can attach the error to the
    // offending input instead of only raising a toast.
    let fields: string[] = [];

    switch (exception.code) {
      case 'P2002': {
        status = HttpStatus.CONFLICT;
        fields = this.fields(exception);
        message = fields.length
          ? `«${fields.join('», «')}» դաշտի արժեքն արդեն օգտագործվում է։ Նշեք այլ արժեք։`
          : 'Այս արժեքով գրառում արդեն գոյություն ունի։';
        break;
      }
      case 'P2025':
        status = HttpStatus.NOT_FOUND;
        message = 'Գրառումը չի գտնվել։';
        break;
      case 'P2003':
        status = HttpStatus.BAD_REQUEST;
        message = 'Կապակցված գրառումը գոյություն չունի։';
        break;
      case 'P2014':
        status = HttpStatus.BAD_REQUEST;
        message = 'Գրառումը կապված է այլ տվյալների հետ և չի կարող փոփոխվել։';
        break;
      default:
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        message = 'Ներքին սերվերի սխալ';
        // Only the genuinely unexpected codes are worth logging.
        this.logger.error(`Unhandled Prisma error ${exception.code}: ${exception.message}`);
    }

    response.status(status).json({
      statusCode: status,
      message,
      error: exception.code,
      ...(fields.length ? { fields } : {}),
    });
  }
}
