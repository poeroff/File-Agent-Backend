import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StorageService } from '../storage/storage.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    return this.storage.listUserObjects(request.user.sub);
  }

  @Get('download')
  async download(
    @Req() request: AuthenticatedRequest,
    @Query('key') key: string,
    @Query('inline') inline?: string,
  ) {
    if (!key) throw new BadRequestException('key is required');
    const url = await this.storage.getDownloadUrl(
      request.user.sub,
      key,
      inline === '1' || inline === 'true',
    );
    return { url };
  }

  @Post('folder')
  async createFolder(
    @Req() request: AuthenticatedRequest,
    @Body() body: { path?: string; name?: string },
  ) {
    if (!body?.name) throw new BadRequestException('name is required');
    await this.storage.createUserSubfolder(
      request.user.sub,
      body.path ?? '',
      body.name,
    );
    return { ok: true };
  }

  // Presigned PUT URL so the browser uploads straight to S3 (no large body
  // streamed through this server).
  @Post('upload-url')
  async uploadUrl(
    @Req() request: AuthenticatedRequest,
    @Body() body: { path?: string; name?: string },
  ) {
    if (!body?.name) throw new BadRequestException('name is required');
    return this.storage.getUploadUrl(
      request.user.sub,
      body.path ?? '',
      body.name,
    );
  }

  // --- Multipart upload (large files, in chunks) ---------------------------

  @Post('multipart/create')
  async multipartCreate(
    @Req() request: AuthenticatedRequest,
    @Body() body: { path?: string; name?: string; contentType?: string },
  ) {
    if (!body?.name) throw new BadRequestException('name is required');
    return this.storage.createMultipartUpload(
      request.user.sub,
      body.path ?? '',
      body.name,
      body.contentType,
    );
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
    await this.storage.completeMultipartUpload(
      request.user.sub,
      body.key,
      body.uploadId,
      body.parts,
    );
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
    await this.storage.abortMultipartUpload(
      request.user.sub,
      body.key,
      body.uploadId,
    );
    return { ok: true };
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { path?: string; name?: string },
  ) {
    if (!file) throw new BadRequestException('file is required');
    const name = body?.name || file.originalname;
    await this.storage.uploadUserFile(
      request.user.sub,
      body.path ?? '',
      name,
      file.buffer,
      file.mimetype,
    );
    return { ok: true };
  }

  @Get('trash')
  async listTrash(@Req() request: AuthenticatedRequest) {
    return this.storage.listUserTrash(request.user.sub);
  }

  @Post('trash')
  async moveToTrash(
    @Req() request: AuthenticatedRequest,
    @Body() body: { paths?: string[] },
  ) {
    if (!Array.isArray(body?.paths) || body.paths.length === 0) {
      throw new BadRequestException('paths is required');
    }
    await this.storage.moveToTrash(request.user.sub, body.paths);
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
    await this.storage.restoreFromTrash(request.user.sub, body.entryIds);
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
    await this.storage.deleteTrashEntries(request.user.sub, body.entryIds);
    return { ok: true };
  }

  @Post('trash/empty')
  async emptyTrash(@Req() request: AuthenticatedRequest) {
    await this.storage.emptyTrash(request.user.sub);
    return { ok: true };
  }
}
