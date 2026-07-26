import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
  /**
   * Chunk size for server-side streaming ingestion. Above S3's 5MB part
   * minimum, and small enough that several concurrent imports don't add up to
   * meaningful memory.
   */
  static readonly INGEST_PART_SIZE = 8 * 1024 * 1024;

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

  // --- Blob operations ------------------------------------------------------
  // The database owns where a file appears in the drive; S3 only holds bytes
  // under an opaque key. Everything below takes that key (relative to the
  // user's prefix) rather than a user-visible path.

  /** Presigned PUT so the browser can upload straight into `blobKey`. */
  async getBlobUploadUrl(userId: string, blobKey: string): Promise<string> {
    this.assertConfigured();
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.fullKey(userId, blobKey),
    });
    return getSignedUrl(this.s3, command, { expiresIn: 300 });
  }

  /**
   * Presigned GET for `blobKey`, saved (or shown inline) as `filename`. The
   * name comes from the database rather than the key, which is why an opaque
   * key doesn't cost the user a meaningful download name.
   */
  async getBlobDownloadUrl(
    userId: string,
    blobKey: string,
    filename: string,
    inline = false,
  ): Promise<string> {
    this.assertConfigured();
    // RFC 5987 encoding so non-ASCII (e.g. Korean) filenames survive.
    const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`;
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.fullKey(userId, blobKey),
      ResponseContentDisposition: disposition,
    });
    return getSignedUrl(this.s3, command, { expiresIn: 300 });
  }

  /** Writes bytes to `blobKey` from the server (small, non-presigned uploads). */
  async putBlob(
    userId: string,
    blobKey: string,
    body: Buffer,
    contentType?: string,
  ): Promise<void> {
    this.assertConfigured();
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(userId, blobKey),
        Body: body,
        ContentType: this.safeContentType(contentType),
      }),
    );
  }

  /**
   * Streams bytes into `blobKey` without buffering the whole object.
   *
   * Used for server-side ingestion (importing from another storage provider),
   * where the size often isn't known up front. Small objects go in one PUT;
   * anything past the first part switches to multipart, so memory stays at one
   * part regardless of how large the file turns out to be.
   */
  async putBlobStream(
    userId: string,
    blobKey: string,
    body: AsyncIterable<Uint8Array>,
    contentType?: string,
  ): Promise<number> {
    this.assertConfigured();
    const key = this.fullKey(userId, blobKey);
    const partSize = StorageService.INGEST_PART_SIZE;

    let buffered: Buffer[] = [];
    let bufferedBytes = 0;
    let total = 0;
    let uploadId: string | undefined;
    const parts: MultipartPart[] = [];

    const flushPart = async (): Promise<void> => {
      const chunk = Buffer.concat(buffered, bufferedBytes);
      buffered = [];
      bufferedBytes = 0;
      uploadId ??= await this.createMultipartUpload(
        userId,
        blobKey,
        contentType,
      );
      const partNumber = parts.length + 1;
      const res = await this.s3.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: chunk,
        }),
      );
      if (!res.ETag) throw new Error('Missing ETag on uploaded part');
      parts.push({ partNumber, etag: res.ETag });
    };

    try {
      for await (const chunk of body) {
        const buf = Buffer.from(chunk);
        buffered.push(buf);
        bufferedBytes += buf.length;
        total += buf.length;
        if (bufferedBytes >= partSize) await flushPart();
      }

      if (uploadId === undefined) {
        // Never grew past one part: a plain PUT is cheaper than multipart.
        await this.putBlob(
          userId,
          blobKey,
          Buffer.concat(buffered, bufferedBytes),
          contentType,
        );
        return total;
      }

      if (bufferedBytes > 0) await flushPart();
      await this.completeMultipartUpload(userId, blobKey, uploadId, parts);
      return total;
    } catch (error) {
      if (uploadId !== undefined) {
        await this.abortMultipartUpload(userId, blobKey, uploadId).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  /** What S3 actually stored, used to confirm an upload really landed. */
  async headBlob(
    userId: string,
    blobKey: string,
  ): Promise<{
    size: number;
    contentType: string | null;
    etag: string | null;
    lastModified: Date;
  }> {
    this.assertConfigured();
    const res = await this.s3.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(userId, blobKey),
      }),
    );
    return {
      size: res.ContentLength ?? 0,
      contentType: res.ContentType ?? null,
      etag: res.ETag ?? null,
      lastModified: res.LastModified ?? new Date(),
    };
  }

  /** Permanently removes blobs. Missing keys are not an error. */
  async deleteBlobs(userId: string, blobKeys: string[]): Promise<void> {
    this.assertConfigured();
    if (blobKeys.length === 0) return;
    await this.deleteKeys(blobKeys.map((key) => this.fullKey(userId, key)));
  }

  /**
   * Every object under the user's prefix, trash included, so the index can be
   * built from a bucket that predates it. Hides nothing — the caller decides
   * what each key means.
   */
  async listAllUserKeys(userId: string): Promise<
    {
      key: string;
      size: number;
      lastModified: Date;
      etag: string | null;
    }[]
  > {
    this.assertConfigured();
    const prefix = `users/${userId}/`;
    const objects: {
      key: string;
      size: number;
      lastModified: Date;
      etag: string | null;
    }[] = [];
    for (const object of await this.listAllObjects(prefix)) {
      if (!object.Key) continue;
      const key = object.Key.slice(prefix.length);
      if (key === '') continue; // the user's own folder marker
      objects.push({
        key,
        size: object.Size ?? 0,
        lastModified: object.LastModified ?? new Date(),
        // Comes free with the listing, and is what tells us later whether an
        // object's bytes have been replaced since we last looked at them.
        etag: object.ETag ?? null,
      });
    }
    return objects;
  }

  private fullKey(userId: string, relativeKey: string): string {
    return `users/${userId}/${this.normalizePath(relativeKey)}`;
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
    blobKey: string,
    contentType?: string,
  ): Promise<string> {
    this.assertConfigured();
    const res = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.fullKey(userId, blobKey),
        ContentType: this.safeContentType(contentType),
      }),
    );
    if (!res.UploadId) throw new Error('Failed to start multipart upload');
    return res.UploadId;
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
    const fullKey = this.fullKey(userId, key);
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
    const fullKey = this.fullKey(userId, key);
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
    const fullKey = this.fullKey(userId, key);
    await this.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: fullKey,
        UploadId: uploadId,
      }),
    );
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
