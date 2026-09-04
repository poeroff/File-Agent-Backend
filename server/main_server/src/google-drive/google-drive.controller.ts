import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { DriveImportService } from './drive-import.service';

/**
 * Importing files from an external provider (currently Google Drive) into this
 * drive. It keeps the original `files/import/gdrive` path so the frontend is
 * unaffected, but lives in its own module because it's a self-contained
 * integration rather than part of the core file surface.
 */
@UseGuards(JwtAuthGuard)
@Controller('files')
export class GoogleDriveController {
  constructor(private readonly imports: DriveImportService) {}

  /**
   * Copies files the user picked in Google Drive into this drive.
   *
   * The access token comes from the browser per request and is never stored:
   * it carries the `drive.file` scope, so it only reaches files the user chose
   * in the picker.
   */
  @Post('import/gdrive')
  async importFromGoogleDrive(
    @Req() request: AuthenticatedRequest,
    @Body()
    body: {
      accessToken?: string;
      fileIds?: string[];
      path?: string;
      drive?: string;
    },
  ) {
    if (!body?.accessToken) {
      throw new BadRequestException('accessToken is required');
    }
    if (!Array.isArray(body?.fileIds) || body.fileIds.length === 0) {
      throw new BadRequestException('fileIds is required');
    }
    const results = await this.imports.importFromGoogleDrive(
      // Same convention as FilesController: "shared" targets the shared drive.
      body.drive === 'shared' ? 'shared' : request.user.sub,
      body.accessToken,
      body.fileIds,
      body.path ?? '',
    );
    return {
      imported: results.filter((result) => result.path && !result.error).length,
      results,
    };
  }
}
