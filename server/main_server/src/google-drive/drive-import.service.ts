import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { FileIndexService } from '../files/file-index.service';
import { GoogleDriveService, type DriveFile } from './google-drive.service';

/** Outcome per item, so a partly failed import can be reported honestly. */
export interface ImportResult {
  name: string;
  path?: string;
  bytes?: number;
  skipped?: string;
  error?: string;
}

/** Folders are walked, but not indefinitely — a cycle or a monster tree stops here. */
const MAX_DEPTH = 20;
const MAX_FILES = 500;

/**
 * Copies files out of another storage provider into this drive.
 *
 * The bytes are written once, straight into a blob, and the index gets the path
 * — the same shape as a browser upload, so imported files are ordinary files
 * afterwards with nothing special about them.
 */
@Injectable()
export class DriveImportService {
  private readonly logger = new Logger(DriveImportService.name);

  constructor(
    private readonly index: FileIndexService,
    private readonly storage: StorageService,
    private readonly drive: GoogleDriveService,
  ) {}

  /**
   * Imports the picked Drive items into `destination`. Picked folders are
   * recreated as folders and their contents come along.
   */
  async importFromGoogleDrive(
    userId: string,
    accessToken: string,
    fileIds: string[],
    destination: string,
  ): Promise<ImportResult[]> {
    const results: ImportResult[] = [];
    const budget = { remaining: MAX_FILES };

    for (const fileId of fileIds) {
      try {
        const file = await this.drive.getFile(accessToken, fileId);
        await this.importItem(
          userId,
          accessToken,
          file,
          destination,
          results,
          budget,
          0,
        );
      } catch (error) {
        results.push({ name: fileId, error: this.reason(error) });
      }
    }
    return results;
  }

  private async importItem(
    userId: string,
    accessToken: string,
    file: DriveFile,
    destination: string,
    results: ImportResult[],
    budget: { remaining: number },
    depth: number,
  ): Promise<void> {
    if (budget.remaining <= 0) {
      results.push({
        name: file.name,
        skipped: 'too many files in one import',
      });
      return;
    }

    if (file.isFolder) {
      if (depth >= MAX_DEPTH) {
        results.push({ name: file.name, skipped: 'folder nested too deeply' });
        return;
      }
      const folderPath = await this.index.createFolder(
        userId,
        destination,
        file.name,
      );
      const children = await this.drive.listChildren(accessToken, file.id);
      results.push({
        name: file.name,
        path: folderPath,
        // An empty listing is usually not an empty folder: under the narrow
        // `drive.file` scope Drive hides children the app was never granted, so
        // say so rather than leaving an unexplained empty folder behind.
        ...(children.length === 0
          ? {
              skipped:
                'folder contents not visible with the current permission',
            }
          : {}),
      });
      for (const child of children) {
        await this.importItem(
          userId,
          accessToken,
          child,
          folderPath,
          results,
          budget,
          depth + 1,
        );
      }
      return;
    }

    budget.remaining -= 1;
    let content: Awaited<ReturnType<GoogleDriveService['openContent']>>;
    try {
      content = await this.drive.openContent(accessToken, file);
    } catch (error) {
      results.push({ name: file.name, skipped: this.reason(error) });
      return;
    }

    // Reserve the row first, exactly like a browser upload, so the name is
    // settled up front and a failure leaves a record pointing at the blob.
    const reserved = await this.index.beginUpload(
      userId,
      destination,
      content.name,
      content.contentType,
    );
    try {
      const bytes = await this.storage.putBlobStream(
        userId,
        reserved.blobKey,
        content.body,
        content.contentType,
      );
      await this.index.completeUpload(userId, reserved.blobKey);
      results.push({ name: content.name, path: reserved.path, bytes });
    } catch (error) {
      await this.index.cancelUpload(userId, reserved.blobKey);
      this.logger.warn(
        `Import failed for ${content.name}: ${this.reason(error)}`,
      );
      results.push({ name: content.name, error: this.reason(error) });
    }
  }

  private reason(error: unknown): string {
    if (error instanceof Error) {
      // Nest exceptions carry the useful message in `response.message`.
      const response = (error as { response?: { message?: string } }).response;
      return response?.message ?? error.message;
    }
    return String(error);
  }
}
