import { ConfigService } from '@nestjs/config';
import { MinioAdminService } from './minio-admin.service';

describe('MinioAdminService', () => {
  const config = new ConfigService({
    S3_ENDPOINT: 'http://nas:9000',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'admin',
    AWS_SECRET_ACCESS_KEY: 'secret',
  });

  afterEach(() => jest.restoreAllMocks());

  test('sums drive space across servers and signs the admin request', async () => {
    // Arrange
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          servers: [
            { drives: [{ totalspace: 100, usedspace: 40, availspace: 60 }] },
            { drives: [{ totalspace: 50, usedspace: 10, availspace: 40 }] },
          ],
        }),
        { status: 200 },
      ),
    );
    const service = new MinioAdminService(config);

    // Act
    const usage = await service.getDiskUsage();

    // Assert
    expect(usage).toEqual({ totalBytes: 150, usedBytes: 50, freeBytes: 100 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://nas:9000/minio/admin/v3/info');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=admin\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  test('throws when MinIO rejects the request', async () => {
    // Arrange
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('denied', { status: 403 }));
    const service = new MinioAdminService(config);

    // Act + Assert
    await expect(service.getDiskUsage()).rejects.toThrow('403');
  });

  test('throws when S3_ENDPOINT is not configured', async () => {
    // Arrange
    // ConfigService falls through to process.env, so stub it out entirely.
    const emptyConfig = { get: () => undefined } as unknown as ConfigService;
    const service = new MinioAdminService(emptyConfig);

    // Act + Assert
    await expect(service.getDiskUsage()).rejects.toThrow('S3_ENDPOINT');
  });
});
