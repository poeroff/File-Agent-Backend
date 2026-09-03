import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type _Object,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { toProxyUrl } from './proxy-url';
import { Readable } from 'stream';

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

@Injectable()
export class StorageService {
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
   * Chunk size for server-side streaming ingestion. Above S3's 5MB part
   * minimum, and small enough that several concurrent imports don't add up to
   * meaningful memory.
   */
  static readonly INGEST_PART_SIZE = 8 * 1024 * 1024;

  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  /** When set, browser-facing URLs route through `/storage/proxy` on this API. */
  private readonly publicApiUrl?: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('AWS_S3_BUCKET') ?? '';
    // Region comes from config; credentials are left to the default AWS
    // credential chain (env vars locally, IAM role once this runs on AWS),
    // so no secrets need to be hardcoded.
    // S3_ENDPOINT points at an S3-compatible server (NAS MinIO); path-style
    // is required there because MinIO has no per-bucket DNS.
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    this.s3 = new S3Client({
      region: this.config.get<string>('AWS_REGION') ?? 'us-east-1',
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
    this.publicApiUrl = this.config.get<string>('PUBLIC_API_URL');
  }

  /**
   * Browser-facing presigned URL. With PUBLIC_API_URL set the bytes go
   * frontend → this API → MinIO, so clients outside the tailnet work; without
   * it the raw presigned URL is returned (direct-to-MinIO, dev only).
   */
  private async presignForBrowser(
    command: Parameters<typeof getSignedUrl>[1],
    expiresIn: number,
  ): Promise<string> {
    const signed = await getSignedUrl(this.s3, command, { expiresIn });
    return this.publicApiUrl ? toProxyUrl(this.publicApiUrl, signed) : signed;
  }

  // ponytail: bucket CORS + incomplete-upload lifecycle setup removed — MinIO
  // rejects both AWS-only calls, allows all origins by default, and purges
  // stale multipart uploads with its own scanner. Restore from git history if
  // this ever points back at real AWS S3.

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
    return this.presignForBrowser(command, 300);
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
    return this.presignForBrowser(command, 300);
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
   * where the size often isn't known up front. lib-storage's Upload handles
   * the single-PUT-vs-multipart switch and aborts the upload on failure;
   * queueSize 1 keeps memory at one part regardless of file size.
   */
  async putBlobStream(
    userId: string,
    blobKey: string,
    body: AsyncIterable<Uint8Array>,
    contentType?: string,
  ): Promise<number> {
    this.assertConfigured();
    let total = 0;
    const counted = async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of body) {
        total += chunk.length;
        yield chunk;
      }
    };
    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: this.bucket,
        Key: this.fullKey(userId, blobKey),
        Body: Readable.from(counted()),
        ContentType: this.safeContentType(contentType),
      },
      partSize: StorageService.INGEST_PART_SIZE,
      queueSize: 1,
    });
    await upload.done();
    return total;
  }

  /** What S3 actually stored, used to confirm an upload really landed. */
  async headBlob(
    userId: string,
    blobKey: string,
  ): Promise<{
    size: number;
    contentType: string | null;
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
  async listAllUserKeys(
    userId: string,
  ): Promise<{ key: string; size: number; lastModified: Date }[]> {
    this.assertConfigured();
    const prefix = `users/${userId}/`;
    const objects: { key: string; size: number; lastModified: Date }[] = [];
    for (const object of await this.listAllObjects(prefix)) {
      if (!object.Key) continue;
      const key = object.Key.slice(prefix.length);
      if (key === '') continue; // the user's own folder marker
      objects.push({
        key,
        size: object.Size ?? 0,
        lastModified: object.LastModified ?? new Date(),
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
        await this.presignForBrowser(
          command,
          StorageService.PART_URL_TTL_SECONDS,
        ),
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
