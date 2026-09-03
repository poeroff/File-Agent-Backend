/**
 * Browser-facing URLs point at this API (`/storage/proxy?u=…`) instead of
 * MinIO, so people outside the tailnet can still upload/download. The token
 * is the internal presigned URL, base64url-encoded; the signature inside it
 * (with its expiry) is what authorizes the request, so the proxy adds no auth
 * of its own — it only refuses to forward anywhere but MinIO.
 */
export function toProxyUrl(publicApiUrl: string, signedUrl: string): string {
  const token = Buffer.from(signedUrl).toString('base64url');
  return `${publicApiUrl.replace(/\/$/, '')}/storage/proxy?u=${token}`;
}

export function decodeProxyTarget(token: string, allowedOrigin: string): URL {
  const target = new URL(Buffer.from(token, 'base64url').toString());
  if (target.origin !== new URL(allowedOrigin).origin) {
    throw new Error('proxy target origin is not the storage endpoint');
  }
  return target;
}
