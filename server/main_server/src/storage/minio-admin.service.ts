import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'crypto';

export interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

interface MinioInfo {
  servers?: {
    drives?: { totalspace?: number; usedspace?: number; availspace?: number }[];
  }[];
}

const sha256Hex = (data: string) =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/**
 * Talks to MinIO's admin API, which the S3 SDK doesn't cover. Only one GET is
 * needed, so the SigV4 signature is hand-rolled on node's crypto rather than
 * pulling in the SDK's internal signing packages.
 */
@Injectable()
export class MinioAdminService {
  constructor(private readonly config: ConfigService) {}

  /** Whole-disk space on the MinIO host, summed across all drives. */
  async getDiskUsage(): Promise<DiskUsage> {
    const info = await this.adminGet<MinioInfo>('/minio/admin/v3/info');
    const drives = (info.servers ?? []).flatMap((s) => s.drives ?? []);
    return drives.reduce(
      (acc, d) => ({
        totalBytes: acc.totalBytes + (d.totalspace ?? 0),
        usedBytes: acc.usedBytes + (d.usedspace ?? 0),
        freeBytes: acc.freeBytes + (d.availspace ?? 0),
      }),
      { totalBytes: 0, usedBytes: 0, freeBytes: 0 },
    );
  }

  private async adminGet<T>(path: string): Promise<T> {
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    if (!endpoint) {
      throw new Error('S3_ENDPOINT is not configured');
    }
    const url = new URL(endpoint);
    const region = this.config.get<string>('AWS_REGION') ?? 'us-east-1';
    const accessKey = this.config.get<string>('AWS_ACCESS_KEY_ID') ?? '';
    const secretKey = this.config.get<string>('AWS_SECRET_ACCESS_KEY') ?? '';

    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256Hex('');
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      'GET',
      path,
      '',
      `host:${url.host}`,
      `x-amz-content-sha256:${payloadHash}`,
      `x-amz-date:${amzDate}`,
      '',
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey)
      .update(stringToSign)
      .digest('hex');

    const response = await fetch(`${url.origin}${path}`, {
      headers: {
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    });
    if (!response.ok) {
      throw new Error(`MinIO admin API ${path} returned ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
