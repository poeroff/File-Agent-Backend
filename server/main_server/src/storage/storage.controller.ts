import {
  BadRequestException,
  Controller,
  Get,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Readable } from 'stream';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MinioAdminService } from './minio-admin.service';
import { decodeProxyTarget } from './proxy-url';

/** Headers copied verbatim between the browser and MinIO. */
const REQUEST_HEADERS = ['content-type', 'content-length', 'range'];
const RESPONSE_HEADERS = [
  'etag',
  'content-type',
  'content-length',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'last-modified',
];

@Controller('storage')
export class StorageController {
  constructor(
    private readonly minioAdmin: MinioAdminService,
    private readonly config: ConfigService,
  ) {}

  /** Free/used/total bytes on the NAS disk backing MinIO. */
  @UseGuards(JwtAuthGuard)
  @Get('usage')
  usage() {
    return this.minioAdmin.getDiskUsage();
  }

  /**
   * Streams a presigned MinIO request through this server (see proxy-url.ts).
   * No JWT here: the presigned signature inside `u` is the credential, exactly
   * as it was when the browser hit MinIO directly.
   */
  @Get('proxy')
  proxyGet(
    @Query('u') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.forward(token, req, res);
  }

  @Put('proxy')
  proxyPut(
    @Query('u') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.forward(token, req, res);
  }

  private async forward(token: string, req: Request, res: Response) {
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    if (!token || !endpoint) throw new BadRequestException('bad proxy target');
    let target: URL;
    try {
      target = decodeProxyTarget(token, endpoint);
    } catch {
      throw new BadRequestException('bad proxy target');
    }

    const headers: Record<string, string> = {};
    for (const h of REQUEST_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers,
    };
    if (req.method === 'PUT') {
      init.body = Readable.toWeb(req) as ReadableStream;
      init.duplex = 'half';
    }
    const upstream = await fetch(target, init);

    res.status(upstream.status);
    for (const h of RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body as WebReadableStream).pipe(res);
  }
}
