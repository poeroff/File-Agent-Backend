import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import archiver from 'archiver';
import { StorageService } from '../storage/storage.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { FileIndexService } from './file-index.service';
import { TrashService } from './trash.service';

/**
 * The drive's HTTP surface.
 *
 * Two collaborators, with a clean split: FileIndexService knows where files
 * appear in the user's drive, StorageService knows where their bytes are. A
 * `key` in these endpoints is a user-visible path (what the frontend shows);
 * a `blobKey` is the opaque S3 key underneath it, only ever handed to the
 * client as an upload target.
 */
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  constructor(
    private readonly storage: StorageService,
    private readonly index: FileIndexService,
    private readonly trash: TrashService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    return this.index.listDrive(request.user.sub);
  }

  @Get('download')
  async download(
    @Req() request: AuthenticatedRequest,
    @Query('key') key: string,
    @Query('inline') inline?: string,
  ) {
    if (!key) throw new BadRequestException('key is required');
    const userId = request.user.sub;
    const file = await this.index.resolveFile(userId, key);
    const url = await this.storage.getBlobDownloadUrl(
      userId,
      file.blobKey,
      file.name,
      inline === '1' || inline === 'true',
    );
    return { url };
  }

  /**
   * Streams a folder as a zip. Unlike single-file downloads (presigned,
   * direct from S3) the bytes pass through this server: a zip has no object
   * to presign, so it's assembled here entry by entry without buffering.
   */
  @Get('download-zip')
  async downloadZip(
    @Req() request: AuthenticatedRequest,
    @Query('key') key: string,
    @Res() res: Response,
  ) {
    if (!key) throw new BadRequestException('key is required');
    const userId = request.user.sub;
    const { name, files } = await this.index.resolveFolderFiles(userId, key);

    res.setHeader('Content-Type', 'application/zip');
    // RFC 5987 encoding so non-ASCII (e.g. Korean) folder names survive.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.zip`)}`,
    );

    // store (no deflate): drive content is mostly already-compressed media,
    // and deflate would pin a CPU core per download for little size gain.
    const archive = archiver('zip', { store: true });
    archive.on('error', () => res.destroy());
    archive.pipe(res);
    // ponytail: every entry's S3 stream is opened up front (archiver reads
    // them serially). Fine for ordinary folders; switch to just-in-time
    // appends if huge folders exhaust connections or hit idle timeouts.
    for (const file of files) {
      archive.append(await this.storage.getBlobStream(userId, file.blobKey), {
        name: file.relativePath,
      });
    }
    await archive.finalize();
  }

  @Post('folder')
  async createFolder(
    @Req() request: AuthenticatedRequest,
    @Body() body: { path?: string; name?: string },
  ) {
    if (!body?.name) throw new BadRequestException('name is required');
    const path = await this.index.createFolder(
      request.user.sub,
      body.path ?? '',
      body.name,
    );
    return { ok: true, path };
  }

  @Post('move')
  async move(
    @Req() request: AuthenticatedRequest,
    @Body() body: { paths?: string[]; destination?: string },
  ) {
    if (!Array.isArray(body?.paths) || body.paths.length === 0) {
      throw new BadRequestException('paths is required');
    }
    await this.index.move(request.user.sub, body.paths, body.destination ?? '');
    return { ok: true };
  }

  @Post('rename')
  async rename(
    @Req() request: AuthenticatedRequest,
    @Body() body: { path?: string; name?: string },
  ) {
    if (!body?.path || !body?.name) {
      throw new BadRequestException('path and name are required');
    }
    const path = await this.index.rename(
      request.user.sub,
      body.path,
      body.name,
    );
    return { ok: true, path };
  }

  // --- Upload (browser → S3 directly; no large body passes through here) ----

  /**
   * Reserves the file in the index and returns a presigned PUT URL. `key` is
   * the blob to upload to, and the client hands it back to `upload/complete`.
   */
  @Post('upload-url')
  async uploadUrl(
    @Req() request: AuthenticatedRequest,
    @Body() body: { path?: string; name?: string; contentType?: string },
  ) {
    if (!body?.name) throw new BadRequestException('name is required');
    const userId = request.user.sub;
    const reserved = await this.index.beginUpload(
      userId,
      body.path ?? '',
      body.name,
      body.contentType,
    );
    const url = await this.storage.getBlobUploadUrl(userId, reserved.blobKey);
    return { url, key: reserved.blobKey, path: reserved.path };
  }

  /**
   * Marks a single-request upload as finished. Needed because the bytes go
   * straight to S3, so this server otherwise never learns that they arrived.
   */
  @Post('upload/complete')
  async uploadComplete(
    @Req() request: AuthenticatedRequest,
    @Body() body: { key?: string },
  ) {
    if (!body?.key) throw new BadRequestException('key is required');
    await this.index.completeUpload(request.user.sub, body.key);
    return { ok: true };
  }

  /** Releases the reserved row and blob when an upload is given up on. */
  @Post('upload/abort')
  async uploadAbort(
    @Req() request: AuthenticatedRequest,
    @Body() body: { key?: string },
  ) {
    if (!body?.key) throw new BadRequestException('key is required');
    await this.index.cancelUpload(request.user.sub, body.key);
    return { ok: true };
  }

  // --- Multipart upload (large files, uploaded in chunks) -------------------

  @Post('multipart/create')
  async multipartCreate(
    @Req() request: AuthenticatedRequest,
    @Body() body: { path?: string; name?: string; contentType?: string },
  ) {
    if (!body?.name) throw new BadRequestException('name is required');
    const userId = request.user.sub;
    const reserved = await this.index.beginUpload(
      userId,
      body.path ?? '',
      body.name,
      body.contentType,
    );
    const uploadId = await this.storage.createMultipartUpload(
      userId,
      reserved.blobKey,
      body.contentType,
    );
    return { uploadId, key: reserved.blobKey, path: reserved.path };
  }

  /**
   * Signs `parts` URLs starting at `firstPart` (default 1), so a client
   * uploading a large file can sign a window at a time instead of every part
   * up front. Returns the URLs in part-number order.
   */
  @Post('multipart/urls')
  async multipartUrls(
    @Req() request: AuthenticatedRequest,
    @Body()
    body: {
      key?: string;
      uploadId?: string;
      parts?: number;
      firstPart?: number;
    },
  ) {
    if (!body?.key || !body?.uploadId || !body?.parts) {
      throw new BadRequestException('key, uploadId and parts are required');
    }
    const urls = await this.storage.getMultipartPartUrls(
      request.user.sub,
      body.key,
      body.uploadId,
      body.parts,
      body.firstPart ?? 1,
    );
    return { urls, firstPart: body.firstPart ?? 1 };
  }

  @Post('multipart/complete')
  async multipartComplete(
    @Req() request: AuthenticatedRequest,
    @Body()
    body: {
      key?: string;
      uploadId?: string;
      parts?: { partNumber: number; etag: string }[];
    },
  ) {
    if (!body?.key || !body?.uploadId || !Array.isArray(body?.parts)) {
      throw new BadRequestException('key, uploadId and parts are required');
    }
    const userId = request.user.sub;
    await this.storage.completeMultipartUpload(
      userId,
      body.key,
      body.uploadId,
      body.parts,
    );
    // The assembled object exists now, so the reserved row becomes real.
    await this.index.completeUpload(userId, body.key);
    return { ok: true };
  }

  @Post('multipart/abort')
  async multipartAbort(
    @Req() request: AuthenticatedRequest,
    @Body() body: { key?: string; uploadId?: string },
  ) {
    if (!body?.key || !body?.uploadId) {
      throw new BadRequestException('key and uploadId are required');
    }
    const userId = request.user.sub;
    await this.storage.abortMultipartUpload(userId, body.key, body.uploadId);
    await this.index.cancelUpload(userId, body.key);
    return { ok: true };
  }

  /**
   * Server-side upload for small files (multipart/form-data). Kept for clients
   * that can't presign; the browser app uses the direct-to-S3 path above.
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { path?: string; name?: string },
  ) {
    if (!file) throw new BadRequestException('file is required');
    const userId = request.user.sub;
    const reserved = await this.index.beginUpload(
      userId,
      body.path ?? '',
      body?.name || file.originalname,
      file.mimetype,
    );
    try {
      await this.storage.putBlob(
        userId,
        reserved.blobKey,
        file.buffer,
        file.mimetype,
      );
      await this.index.completeUpload(userId, reserved.blobKey);
    } catch (error) {
      await this.index.cancelUpload(userId, reserved.blobKey);
      throw error;
    }
    return { ok: true, path: reserved.path };
  }

  // --- Trash ---------------------------------------------------------------

  @Get('trash')
  async listTrash(@Req() request: AuthenticatedRequest) {
    return this.trash.listTrash(request.user.sub);
  }

  @Post('trash')
  async moveToTrash(
    @Req() request: AuthenticatedRequest,
    @Body() body: { paths?: string[] },
  ) {
    if (!Array.isArray(body?.paths) || body.paths.length === 0) {
      throw new BadRequestException('paths is required');
    }
    await this.trash.moveToTrash(request.user.sub, body.paths);
    return { ok: true };
  }

  @Post('restore')
  async restore(
    @Req() request: AuthenticatedRequest,
    @Body() body: { entryIds?: string[] },
  ) {
    if (!Array.isArray(body?.entryIds) || body.entryIds.length === 0) {
      throw new BadRequestException('entryIds is required');
    }
    await this.trash.restore(request.user.sub, body.entryIds);
    return { ok: true };
  }

  @Post('trash/delete')
  async deleteTrash(
    @Req() request: AuthenticatedRequest,
    @Body() body: { entryIds?: string[] },
  ) {
    if (!Array.isArray(body?.entryIds) || body.entryIds.length === 0) {
      throw new BadRequestException('entryIds is required');
    }
    await this.trash.deleteTrashEntries(request.user.sub, body.entryIds);
    return { ok: true };
  }

  @Post('trash/empty')
  async emptyTrash(@Req() request: AuthenticatedRequest) {
    await this.trash.emptyTrash(request.user.sub);
    return { ok: true };
  }
}
