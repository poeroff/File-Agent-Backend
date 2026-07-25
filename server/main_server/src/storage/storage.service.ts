import { randomUUID } from 'crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type LifecycleRule,
  type _Object,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

// Reserved folder that holds trashed items; hidden from the normal listing.
const TRASH_PREFIX = '.trash/';

export interface StorageObject {
  /** Key relative to the user's folder, e.g. "Photos/pic.jpg" or "Photos/". */
  key: string;
  size: number;
  /** Last-modified time in epoch milliseconds. */
  lastModified: number;
}

export interface TrashEntry {
  /** Opaque id used to restore/delete this entry. */
  entryId: string;
  /** Original path this was trashed from (folders end with "/"). */
  originalPath: string;
  name: string;
  type: 'file' | 'folder';
  size: number;
  lastModified: number;
}

@Injectable()
export class StorageService implements OnModuleInit {
  /** S3's hard ceiling on parts per multipart upload. */
  static readonly MAX_PARTS = 10000;
  /**
   * How long a part URL stays valid. Generous on purpose: a 20GB upload on a
   * 5MB/s uplink runs well over an hour, and the old 1h TTL guaranteed a
   * mid-upload `403 Request has expired`. SigV4 allows up to 7 days with
   * long-lived keys — but note that under temporary credentials (IAM role,
   * STS) the URL dies with the session regardless, so the client must still
   * treat an expired part URL as recoverable and ask for a fresh one.
   */
  static readonly PART_URL_TTL_SECONDS = 6 * 60 * 60;
  /**
   * Grace period before S3 discards the parts of an upload that was never
   * completed or aborted. Long enough that a paused upload could in principle
   * be resumed, short enough that abandoned parts don't sit there billing.
   */
  static readonly ABANDONED_UPLOAD_CLEANUP_DAYS = 7;

  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('AWS_S3_BUCKET') ?? '';
    // Region comes from config; credentials are left to the default AWS
    // credential chain (env vars locally, IAM role once this runs on AWS),
    // so no secrets need to be hardcoded.
    this.s3 = new S3Client({
      region: this.config.get<string>('AWS_REGION'),
    });
  }

  // Browsers upload straight to S3 via presigned PUT URLs, which needs the
  // bucket to allow cross-origin PUT/GET. Set that once on startup (best
  // effort — logs a warning if the IAM user lacks s3:PutBucketCORS).
  async onModuleInit(): Promise<void> {
    if (!this.bucket) return;
    try {
      await this.s3.send(
        new PutBucketCorsCommand({
          Bucket: this.bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedMethods: ['PUT', 'GET', 'HEAD'],
                AllowedOrigins: ['*'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
                MaxAgeSeconds: 3000,
              },
            ],
          },
        }),
      );
      this.logger.log('Ensured S3 bucket CORS for browser uploads');
    } catch (error) {
      this.logger.warn(
        `Could not set bucket CORS (browser uploads may be blocked): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.ensureAbandonedUploadCleanup();
  }

  /**
   * Makes S3 clean up abandoned multipart uploads.
   *
   * The client aborts an upload it gives up on, but it can't when the tab is
   * closed or the machine sleeps mid-upload. Those already-uploaded parts stay
   * billable storage that no listing shows and nothing ever deletes, so the
   * bucket needs a lifecycle rule as the backstop. Best effort, like the CORS
   * rule above: it just warns if the IAM user can't set lifecycle rules.
   */
  private async ensureAbandonedUploadCleanup(): Promise<void> {
    const ruleId = 'abort-incomplete-multipart-uploads';
    try {
      // PutBucketLifecycleConfiguration replaces the whole configuration, so
      // read what's there and keep every rule that isn't ours.
      let existing: LifecycleRule[] = [];
      try {
        const current = await this.s3.send(
          new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
        );
        existing = (current.Rules ?? []).filter((rule) => rule.ID !== ruleId);
      } catch (error) {
        // A bucket with no lifecycle configuration answers with this, which
        // just means there is nothing to preserve.
        const code = (error as { name?: string }).name;
        if (code !== 'NoSuchLifecycleConfiguration') throw error;
      }

      await this.s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.bucket,
          LifecycleConfiguration: {
            Rules: [
              ...existing,
              {
                ID: ruleId,
                Status: 'Enabled',
                Filter: { Prefix: '' },
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation:
                    StorageService.ABANDONED_UPLOAD_CLEANUP_DAYS,
                },
              },
            ],
          },
        }),
      );
      this.logger.log(
        `Ensured S3 lifecycle rule to abort incomplete uploads after ` +
          `${StorageService.ABANDONED_UPLOAD_CLEANUP_DAYS} days`,
      );
    } catch (error) {
      this.logger.warn(
        `Could not set the incomplete-upload lifecycle rule (abandoned ` +
          `multipart parts may accrue storage cost): ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }

  /**
   * S3 has no real folders — a "folder" is just a key prefix. We drop a
   * zero-byte marker object at `users/{userId}/` so the personal folder is
   * visible even before the user uploads anything. Overwriting it is
   * harmless, so this is safe to call more than once.
   */
  async ensureUserFolder(userId: string): Promise<void> {
    this.assertConfigured();

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: `users/${userId}/`,
          Body: '',
        }),
      );
      this.logger.log(`Provisioned S3 folder users/${userId}/`);
    } catch (error) {
      // Log the real AWS reason (NoSuchBucket, AccessDenied, network, …) so
      // it's debuggable, then re-throw for the caller to handle.
      this.logger.error(
        `Failed to provision S3 folder users/${userId}/`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /**
   * Lists everything under the user's folder. Keys are returned relative to
   * `users/{userId}/`, and the folder marker itself is omitted. The frontend
   * turns this flat list into a folder tree.
   */
  async listUserObjects(userId: string): Promise<StorageObject[]> {
    this.assertConfigured();
    const prefix = `users/${userId}/`;

    try {
      const objects: StorageObject[] = [];
      for (const obj of await this.listAllObjects(prefix)) {
        if (!obj.Key) continue;
        const relative = obj.Key.slice(prefix.length);
        if (relative === '') continue; // the folder marker itself
        if (relative.startsWith(TRASH_PREFIX)) continue; // hide the trash
        objects.push({
          key: relative,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified?.getTime() ?? 0,
        });
      }
      return objects;
    } catch (error) {
      this.logger.error(
        `Failed to list S3 objects for users/${userId}/`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /**
   * Returns a short-lived presigned URL for a file. By default it forces a
   * download (attachment); with `inline` it lets the browser render the file
   * in place (using its stored Content-Type) for previewing images/PDFs/etc.
   */
  async getDownloadUrl(
    userId: string,
    key: string,
    inline = false,
  ): Promise<string> {
    this.assertConfigured();
    const normalized = this.normalizePath(key);
    if (!normalized || normalized.endsWith('/')) {
      throw new Error('A file key is required');
    }
    const fullKey = `users/${userId}/${normalized}`;
    const filename = normalized.split('/').pop() ?? 'download';
    // RFC 5987 encoding so non-ASCII (e.g. Korean) filenames survive.
    const disposition = inline
      ? `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
      : `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
      ResponseContentDisposition: disposition,
    });
    return getSignedUrl(this.s3, command, { expiresIn: 300 });
  }

  /**
   * Returns a presigned PUT URL so the browser can upload a file straight to
   * S3, plus the relative key it will land at. Content-Type is intentionally
   * left unsigned so the browser can set it on the PUT (and S3 stores it).
   */
  async getUploadUrl(
    userId: string,
    path: string,
    name: string,
  ): Promise<{ url: string; key: string }> {
    this.assertConfigured();
    const relativeKey = `${this.normalizePath(path)}${this.safeName(name)}`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: `users/${userId}/${relativeKey}`,
    });
    const url = await getSignedUrl(this.s3, command, { expiresIn: 300 });
    return { url, key: relativeKey };
  }

  // --- Multipart upload (large files, uploaded in chunks) --------------------

  /**
   * Starts a multipart upload; returns the S3 upload id and relative key.
   *
   * `contentType` must be passed here and nowhere else: unlike a single PUT,
   * the part uploads can't set it, so whatever is (or isn't) given at create
   * time is what the finished object keeps. Skipping it makes S3 default to
   * `binary/octet-stream`, which stops the browser from previewing large PDFs,
   * images and videos inline.
   */
  async createMultipartUpload(
    userId: string,
    path: string,
    name: string,
    contentType?: string,
  ): Promise<{ uploadId: string; key: string }> {
    this.assertConfigured();
    const relativeKey = `${this.normalizePath(path)}${this.safeName(name)}`;
    const res = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: `users/${userId}/${relativeKey}`,
        ContentType: this.safeContentType(contentType),
      }),
    );
    if (!res.UploadId) throw new Error('Failed to start multipart upload');
    return { uploadId: res.UploadId, key: relativeKey };
  }

  /**
   * Presigned URLs for a *window* of parts (parts are 1-indexed), so the client
   * can sign them shortly before it needs them.
   *
   * Signing every part of a big file up front has two problems: a 20GB file is
   * ~1000 parts, which is a ~700KB response and a few hundred ms of signing;
   * and every one of those URLs starts its clock at the same moment, so a slow
   * connection walks into `403 Request has expired` partway through with no way
   * to recover. A window keeps each response small and each URL young.
   */
  async getMultipartPartUrls(
    userId: string,
    key: string,
    uploadId: string,
    partCount: number,
    firstPartNumber = 1,
  ): Promise<string[]> {
    this.assertConfigured();
    if (!Number.isInteger(partCount) || partCount < 1 || partCount > 1000) {
      throw new Error('partCount must be between 1 and 1000');
    }
    if (
      !Number.isInteger(firstPartNumber) ||
      firstPartNumber < 1 ||
      firstPartNumber + partCount - 1 > StorageService.MAX_PARTS
    ) {
      throw new Error('Invalid part range');
    }
    const fullKey = `users/${userId}/${this.normalizePath(key)}`;
    const last = firstPartNumber + partCount - 1;
    const urls: string[] = [];
    for (
      let partNumber = firstPartNumber;
      partNumber <= last;
      partNumber += 1
    ) {
      const command = new UploadPartCommand({
        Bucket: this.bucket,
        Key: fullKey,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      urls.push(
        await getSignedUrl(this.s3, command, {
          expiresIn: StorageService.PART_URL_TTL_SECONDS,
        }),
      );
    }
    return urls;
  }

  /** Assembles the uploaded parts into the final object. */
  async completeMultipartUpload(
    userId: string,
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<void> {
    this.assertConfigured();
    const fullKey = `users/${userId}/${this.normalizePath(key)}`;
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: fullKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
    this.logger.log(
      `Completed multipart upload ${fullKey} (${parts.length} parts)`,
    );
  }

  /** Cancels an in-progress multipart upload and frees the uploaded parts. */
  async abortMultipartUpload(
    userId: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    this.assertConfigured();
    const fullKey = `users/${userId}/${this.normalizePath(key)}`;
    await this.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: fullKey,
        UploadId: uploadId,
      }),
    );
  }

  /** Uploads a file to `users/{userId}/{path}{name}`. */
  async uploadUserFile(
    userId: string,
    path: string,
    name: string,
    body: Buffer,
    contentType?: string,
  ): Promise<void> {
    this.assertConfigured();
    const key = `users/${userId}/${this.normalizePath(path)}${this.safeName(name)}`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    this.logger.log(`Uploaded ${key} (${body.length} bytes)`);
  }

  /** Creates an empty subfolder marker at `users/{userId}/{path}{name}/`. */
  async createUserSubfolder(
    userId: string,
    path: string,
    name: string,
  ): Promise<void> {
    this.assertConfigured();
    const normalizedPath = this.normalizePath(path);
    const safe = this.safeName(name);
    if (!normalizedPath && `${safe}/` === TRASH_PREFIX) {
      throw new Error(`"${safe}" is a reserved folder name`);
    }
    const key = `users/${userId}/${normalizedPath}${safe}/`;
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: '' }),
    );
    this.logger.log(`Created folder ${key}`);
  }

  /**
   * Moves the given paths into the trash. Each path becomes one trash "entry"
   * keyed by its original location, so it can be restored exactly and folders
   * vs. individual files stay distinguishable.
   */
  async moveToTrash(userId: string, paths: string[]): Promise<void> {
    this.assertConfigured();
    const base = `users/${userId}/`;

    for (const rawPath of paths) {
      const path = this.normalizePath(rawPath);
      if (!path || path.startsWith(TRASH_PREFIX)) continue;

      const { parent } = this.splitPath(path);
      // Append a random suffix so trashing two items with the same original
      // path produces two independent entries instead of overwriting.
      const entryId = `${this.encodeEntryId(path)}.${randomUUID()}`;
      const parentBase = base + parent;
      const srcKeys = await this.listAllKeys(base + path);

      for (const srcKey of srcKeys) {
        const rel = srcKey.slice(parentBase.length);
        const destKey = `${base}${TRASH_PREFIX}${entryId}/${rel}`;
        await this.copyObject(srcKey, destKey);
      }
      await this.deleteKeys(srcKeys);
    }
  }

  /** Restores trash entries back to their original locations. */
  async restoreFromTrash(userId: string, entryIds: string[]): Promise<void> {
    this.assertConfigured();
    const base = `users/${userId}/`;

    for (const entryId of entryIds) {
      const originalPath = this.decodeEntryId(entryId);
      const { parent } = this.splitPath(originalPath);
      const entryPrefix = `${base}${TRASH_PREFIX}${entryId}/`;
      const srcKeys = await this.listAllKeys(entryPrefix);

      for (const srcKey of srcKeys) {
        const rel = srcKey.slice(entryPrefix.length);
        const destKey = `${base}${parent}${rel}`;
        await this.copyObject(srcKey, destKey);
      }
      await this.deleteKeys(srcKeys);
    }
  }

  /** Lists the top-level trash entries (the units the user actually trashed). */
  async listUserTrash(userId: string): Promise<TrashEntry[]> {
    this.assertConfigured();
    const trashBase = `users/${userId}/${TRASH_PREFIX}`;
    // Group every trashed object under its entry id to aggregate size/mtime.
    const agg = new Map<string, { size: number; lastModified: number }>();
    for (const obj of await this.listAllObjects(trashBase)) {
      if (!obj.Key) continue;
      const rel = obj.Key.slice(trashBase.length);
      const slash = rel.indexOf('/');
      const entryId = slash === -1 ? rel : rel.slice(0, slash);
      if (!entryId) continue;
      const cur = agg.get(entryId) ?? { size: 0, lastModified: 0 };
      cur.size += obj.Size ?? 0;
      cur.lastModified = Math.max(
        cur.lastModified,
        obj.LastModified?.getTime() ?? 0,
      );
      agg.set(entryId, cur);
    }

    const entries: TrashEntry[] = [];
    for (const [entryId, meta] of agg) {
      const originalPath = this.decodeEntryId(entryId);
      const { name, isFolder } = this.splitPath(originalPath);
      entries.push({
        entryId,
        originalPath,
        name,
        type: isFolder ? 'folder' : 'file',
        size: meta.size,
        lastModified: meta.lastModified,
      });
    }
    return entries;
  }

  /** Permanently removes the given trash entries. */
  async deleteTrashEntries(userId: string, entryIds: string[]): Promise<void> {
    this.assertConfigured();
    const base = `users/${userId}/`;
    for (const entryId of entryIds) {
      const keys = await this.listAllKeys(`${base}${TRASH_PREFIX}${entryId}/`);
      await this.deleteKeys(keys);
    }
  }

  /** Permanently removes everything in the trash. */
  async emptyTrash(userId: string): Promise<void> {
    this.assertConfigured();
    const keys = await this.listAllKeys(`users/${userId}/${TRASH_PREFIX}`);
    await this.deleteKeys(keys);
  }

  /**
   * Permanently removes trash entries older than `olderThanMs`. A trashed
   * object's LastModified is set to the moment it was moved into the trash
   * (S3 CopyObject stamps the copy time), so that doubles as the "trashed at"
   * time. Returns how many entries were purged.
   */
  async purgeExpiredTrash(
    userId: string,
    olderThanMs: number,
  ): Promise<number> {
    this.assertConfigured();
    const cutoff = Date.now() - olderThanMs;
    const expired = (await this.listUserTrash(userId))
      .filter((entry) => entry.lastModified > 0 && entry.lastModified < cutoff)
      .map((entry) => entry.entryId);

    if (expired.length > 0) {
      await this.deleteTrashEntries(userId, expired);
      this.logger.log(
        `Purged ${expired.length} expired trash entr${expired.length === 1 ? 'y' : 'ies'} for users/${userId}/`,
      );
    }
    return expired.length;
  }

  private encodeEntryId(path: string): string {
    return Buffer.from(path, 'utf8').toString('base64url');
  }

  private decodeEntryId(entryId: string): string {
    // entryId is `<base64url(path)>.<uuid>`; the path never contains a dot.
    const dot = entryId.indexOf('.');
    const encoded = dot === -1 ? entryId : entryId.slice(0, dot);
    return Buffer.from(encoded, 'base64url').toString('utf8');
  }

  /** Splits a relative path into { parent prefix, basename, isFolder }. */
  private splitPath(path: string): {
    parent: string;
    name: string;
    isFolder: boolean;
  } {
    const isFolder = path.endsWith('/');
    const trimmed = isFolder ? path.slice(0, -1) : path;
    const idx = trimmed.lastIndexOf('/');
    return {
      parent: idx === -1 ? '' : trimmed.slice(0, idx + 1),
      name: idx === -1 ? trimmed : trimmed.slice(idx + 1),
      isFolder,
    };
  }

  /** Pages through ListObjectsV2 and returns every object under `prefix`. */
  private async listAllObjects(prefix: string): Promise<_Object[]> {
    const objects: _Object[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      objects.push(...(res.Contents ?? []));
      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return objects;
  }

  private async listAllKeys(prefix: string): Promise<string[]> {
    return (await this.listAllObjects(prefix)).flatMap((obj) =>
      obj.Key ? [obj.Key] : [],
    );
  }

  private async copyObject(srcKey: string, destKey: string): Promise<void> {
    const copySource = [
      this.bucket,
      ...srcKey.split('/').map(encodeURIComponent),
    ].join('/');
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destKey,
        CopySource: copySource,
      }),
    );
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += 1000) {
      const chunk = unique.slice(i, i + 1000);
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
    }
  }

  private assertConfigured(): void {
    if (!this.bucket) {
      throw new Error('AWS_S3_BUCKET is not configured');
    }
  }

  /** Strips a leading slash so a relative path never escapes the user prefix. */
  private normalizePath(path: string): string {
    return path.replace(/^\/+/, '');
  }

  /** A single path segment must not contain slashes. */
  private safeName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes('/')) {
      throw new Error(`Invalid name: ${name}`);
    }
    return trimmed;
  }

  /**
   * The browser-reported MIME type, or the generic fallback. Anything with
   * characters that aren't legal in a header value is rejected rather than
   * signed, since this value ends up in a signed S3 header.
   */
  private safeContentType(contentType?: string): string {
    const trimmed = (contentType ?? '').trim();
    if (!trimmed) return 'application/octet-stream';
    if (
      trimmed.length > 255 ||
      !/^[\w.+-]+\/[\w.+-]+(;[\w.+= -]*)?$/.test(trimmed)
    ) {
      return 'application/octet-stream';
    }
    return trimmed;
  }
}
