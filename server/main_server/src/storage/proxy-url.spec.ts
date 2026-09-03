import { decodeProxyTarget, toProxyUrl } from './proxy-url';

describe('proxy-url', () => {
  const signed =
    'http://100.81.123.104:9000/bucket/users/u/blobs/b?X-Amz-Signature=abc&partNumber=2';

  test('wraps a signed URL into a proxy URL that decodes back to it', () => {
    // Arrange + Act
    const proxied = toProxyUrl('https://api.example.com', signed);
    const target = decodeProxyTarget(
      new URL(proxied).searchParams.get('u') ?? '',
      'http://100.81.123.104:9000',
    );

    // Assert
    expect(proxied.startsWith('https://api.example.com/storage/proxy?u=')).toBe(
      true,
    );
    expect(target.toString()).toBe(signed);
  });

  test('rejects a target on a different origin (no open proxy)', () => {
    // Arrange
    const token = new URL(
      toProxyUrl('https://api.example.com', 'http://evil.example/x'),
    ).searchParams.get('u') as string;

    // Act + Assert
    expect(() =>
      decodeProxyTarget(token, 'http://100.81.123.104:9000'),
    ).toThrow('origin');
  });

  test('rejects garbage tokens', () => {
    expect(() =>
      decodeProxyTarget('%%%', 'http://100.81.123.104:9000'),
    ).toThrow();
  });
});
