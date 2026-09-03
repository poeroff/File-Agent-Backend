import { BadRequestException, Injectable, Logger } from '@nestjs/common';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/** The subset of Drive metadata this app cares about. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedAt: Date;
  isFolder: boolean;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Google-native documents have no bytes to download, so they're exported to a
 * real format instead. Anything else is fetched as-is.
 */
const EXPORT_FORMATS: Record<string, { mimeType: string; extension: string }> =
  {
    'application/vnd.google-apps.document': {
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: '.docx',
    },
    'application/vnd.google-apps.spreadsheet': {
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: '.xlsx',
    },
    'application/vnd.google-apps.presentation': {
      mimeType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: '.pptx',
    },
    'application/vnd.google-apps.drawing': {
      mimeType: 'application/pdf',
      extension: '.pdf',
    },
  };

const FIELDS = 'id,name,mimeType,size,modifiedTime';

/**
 * Reads a user's Google Drive on their behalf.
 *
 * The access token is supplied per request and never stored: the browser
 * obtains it with the `drive.file` scope, which only covers files the user
 * picked themselves. So this service can only ever see what was handed to it.
 */
@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);

  async getFile(accessToken: string, fileId: string): Promise<DriveFile> {
    const res = await this.call(
      accessToken,
      `/files/${encodeURIComponent(fileId)}?fields=${FIELDS}&supportsAllDrives=true`,
    );
    return this.toDriveFile(
      (await res.json()) as Record<string, string | undefined>,
    );
  }

  /** Direct children of a folder the user granted access to. */
  async listChildren(
    accessToken: string,
    folderId: string,
  ): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: '200',
        supportsAllDrives: 'true',
      });
      if (pageToken) query.set('pageToken', pageToken);
      const res = await this.call(accessToken, `/files?${query.toString()}`);
      const body = (await res.json()) as {
        files?: Record<string, string | undefined>[];
        nextPageToken?: string;
      };
      for (const file of body.files ?? []) files.push(this.toDriveFile(file));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }

  /**
   * Opens the file's bytes for streaming, plus the name and type it should be
   * stored under (which differ from Drive's for exported documents).
   */
  async openContent(
    accessToken: string,
    file: DriveFile,
  ): Promise<{
    body: AsyncIterable<Uint8Array>;
    name: string;
    contentType: string;
  }> {
    const exportAs = EXPORT_FORMATS[file.mimeType];
    if (!exportAs && file.mimeType.startsWith('application/vnd.google-apps')) {
      // Forms, Sites, shortcuts and friends have nothing meaningful to store.
      throw new BadRequestException(`Cannot download ${file.mimeType}`);
    }

    const path = exportAs
      ? `/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportAs.mimeType)}`
      : `/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
    const res = await this.call(accessToken, path);
    if (!res.body) throw new Error('Google Drive returned an empty response');

    const name =
      exportAs && !file.name.toLowerCase().endsWith(exportAs.extension)
        ? `${file.name}${exportAs.extension}`
        : file.name;
    return {
      body: res.body as unknown as AsyncIterable<Uint8Array>,
      name,
      contentType:
        exportAs?.mimeType ??
        res.headers.get('content-type') ??
        'application/octet-stream',
    };
  }

  private async call(accessToken: string, path: string): Promise<Response> {
    const res = await fetch(`${DRIVE_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) return res;

    const detail = await res.text().catch(() => '');
    // Never log the token itself, and keep Google's reason for debugging.
    this.logger.warn(`Drive API ${path.split('?')[0]} -> ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      throw new BadRequestException(
        'Google Drive access was refused. Reconnect and try again.',
      );
    }
    if (res.status === 404) {
      // Under the `drive.file` scope a 404 usually isn't a missing file: it's a
      // file this app was never granted, which happens when the picker didn't
      // register the grant (no app id) or the item came from somewhere else.
      throw new BadRequestException(
        'Google Drive did not grant this app access to that file. Pick it again from the picker.',
      );
    }
    throw new Error(`Drive API ${res.status}: ${detail.slice(0, 200)}`);
  }

  private toDriveFile(raw: Record<string, string | undefined>): DriveFile {
    if (!raw.id || !raw.name || !raw.mimeType) {
      throw new Error('Unexpected Drive response');
    }
    return {
      id: raw.id,
      name: raw.name,
      mimeType: raw.mimeType,
      size: Number(raw.size ?? 0),
      modifiedAt: raw.modifiedTime ? new Date(raw.modifiedTime) : new Date(),
      isFolder: raw.mimeType === FOLDER_MIME,
    };
  }
}
