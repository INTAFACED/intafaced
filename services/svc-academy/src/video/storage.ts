/**
 * Stored VOD — S3-compatible signed GET (MinIO). Not LiveKit / SFU.
 *
 * Blank endpoint/keys/bucket is unconfigured. Blank region with storage
 * otherwise on refuses academy.video_s3_region_unset — never invent us-east-1.
 * A URL missing the signature is not a grant. Bucket listing is Class X
 * residual — this file never lists.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AcademyError } from '../errors.js';

export type VideoStorageConfig = {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly region: string;
  /** Owner-published signed-GET lifetime. Unset refuses — never invent seconds. */
  readonly ttlSeconds: number | undefined;
};

export type IssuedPlayback = {
  readonly playbackUrl: string;
  readonly expiresAt: Date;
  readonly grant: string;
};

const UNSIGNED = 'UNSIGNED-PAYLOAD';

export function isVideoStorageConfigured(config: VideoStorageConfig | null | undefined): config is VideoStorageConfig {
  if (!config) return false;
  return (
    config.endpoint.trim().length > 0 &&
    config.bucket.trim().length > 0 &&
    config.accessKey.trim().length > 0 &&
    config.secretKey.trim().length > 0
  );
}

export function assertVideoStorageConfigured(config: VideoStorageConfig | null | undefined): VideoStorageConfig {
  if (!isVideoStorageConfigured(config)) {
    throw new AcademyError(
      'Video object storage is not configured — set ACADEMY_VIDEO_S3_ENDPOINT, bucket, and keys (or leave off)',
      'academy.video_storage_unconfigured',
    );
  }
  return config;
}

/** Blank / non-integer / out of 1..3600 refuses. Never clamp to 1 or 3600. */
export function assertPublishedVideoUrlTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined || typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
    throw new AcademyError(
      'Academy video URL TTL is unset — set ACADEMY_VIDEO_URL_TTL_SECONDS (never invent seconds)',
      'academy.video_url_ttl_unset',
    );
  }
  return ttlSeconds;
}

/** Blank / whitespace refuses. Never invent us-east-1. */
export function assertPublishedVideoS3Region(region: string | undefined): string {
  const trimmed = typeof region === 'string' ? region.trim() : '';
  if (!trimmed) {
    throw new AcademyError(
      'Academy video S3 region is unset — set ACADEMY_VIDEO_S3_REGION (never invent us-east-1)',
      'academy.video_s3_region_unset',
    );
  }
  return trimmed;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** AWS URI-encode: keep unreserved + path slashes. */
function awsEncode(value: string, keepSlash: boolean): string {
  let out = '';
  for (const ch of value) {
    if (/[A-Za-z0-9._~-]/.test(ch) || (keepSlash && ch === '/')) {
      out += ch;
    } else {
      const buf = Buffer.from(ch, 'utf8');
      for (const b of buf) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function endpointParts(endpoint: string): { origin: string; host: string } {
  const u = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`);
  const host = u.port && u.port !== (u.protocol === 'https:' ? '443' : '80') ? u.host : u.hostname;
  return { origin: `${u.protocol}//${u.host}`.replace(/\/$/, ''), host };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function amzDateOf(at: Date): { amzDate: string; dateStamp: string } {
  const dateStamp = `${at.getUTCFullYear()}${pad2(at.getUTCMonth() + 1)}${pad2(at.getUTCDate())}`;
  const amzDate = `${dateStamp}T${pad2(at.getUTCHours())}${pad2(at.getUTCMinutes())}${pad2(at.getUTCSeconds())}Z`;
  return { amzDate, dateStamp };
}

/** Path-style presigned URL for one object and method, valid for the owner's TTL. The bucket is never listed. */
function presign(
  config: VideoStorageConfig,
  method: 'GET' | 'PUT',
  objectKey: string,
  at: Date,
): { url: string; expiresAt: Date; key: string } {
  const storage = assertVideoStorageConfigured(config);
  const key = objectKey.replace(/^\/+/, '');
  if (!key) {
    throw new AcademyError('Video object key is missing — no grant', 'academy.video_grant_required');
  }
  const ttl = assertPublishedVideoUrlTtl(storage.ttlSeconds);
  const expiresAt = new Date(at.getTime() + ttl * 1000);
  const { origin, host } = endpointParts(storage.endpoint);
  const { amzDate, dateStamp } = amzDateOf(at);
  const region = assertPublishedVideoS3Region(storage.region);
  const amzAccessScope = `${storage.accessKey}/${dateStamp}/${region}/s3/aws4_request`;
  const canonicalUri = awsEncode(`/${storage.bucket}/${key}`, true);
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': amzAccessScope,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(ttl),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${awsEncode(k, false)}=${awsEncode(query[k]!, false)}`)
    .join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, 'host', UNSIGNED].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(storage.secretKey, dateStamp, region), stringToSign).toString('hex');
  return { url: `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`, expiresAt, key };
}

/**
 * Path-style presigned GET. Object key is never listed from the bucket.
 */
export function signGetObjectUrl(config: VideoStorageConfig, objectKey: string, at: Date): IssuedPlayback {
  const { url, expiresAt, key } = presign(config, 'GET', objectKey, at);
  return { playbackUrl: url, expiresAt, grant: issueGrant(config.secretKey, key, expiresAt) };
}

/** AC-videos-02: a presigned PUT, so the browser sends a course file's bytes straight to our own store. */
export function signPutObjectUrl(config: VideoStorageConfig, objectKey: string, at: Date): { uploadUrl: string; expiresAt: Date } {
  const { url, expiresAt } = presign(config, 'PUT', objectKey, at);
  return { uploadUrl: url, expiresAt };
}

export function issueGrant(secret: string, bound: string, expiresAt: Date): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const mac = createHmac('sha256', secret).update(`v1|${bound}|${exp}`, 'utf8').digest('hex');
  return `v1.${exp}.${mac}`;
}

export function grantIsValid(secret: string, bound: string, grant: string, now: Date): boolean {
  const parts = grant.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isInteger(exp) || exp * 1000 <= now.getTime()) return false;
  const expected = createHmac('sha256', secret).update(`v1|${bound}|${exp}`, 'utf8').digest('hex');
  const a = Buffer.from(parts[2]!, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * A playback URL is a grant only when the SigV4 signature is present, unexpired,
 * and matches. Missing query is a named refuse — never a public object.
 */
export function assertPlaybackUrlGranted(config: VideoStorageConfig, playbackUrl: string, now: Date): void {
  const storage = assertVideoStorageConfigured(config);
  let parsed: URL;
  try {
    parsed = new URL(playbackUrl);
  } catch {
    throw new AcademyError('Video URL is not a grant', 'academy.video_grant_required');
  }
  const signature = parsed.searchParams.get('X-Amz-Signature');
  const amzDate = parsed.searchParams.get('X-Amz-Date');
  const expiresRaw = parsed.searchParams.get('X-Amz-Expires');
  if (!signature || !amzDate || !expiresRaw) {
    throw new AcademyError('Video URL has no grant signature', 'academy.video_grant_required');
  }
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || expires <= 0) {
    throw new AcademyError('Video URL grant expiry is not a grant', 'academy.video_grant_required');
  }
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!stamp) {
    throw new AcademyError('Video URL grant date is not a grant', 'academy.video_grant_required');
  }
  const signedAt = Date.UTC(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3]), Number(stamp[4]), Number(stamp[5]), Number(stamp[6]));
  if (!Number.isFinite(signedAt) || signedAt + expires * 1000 <= now.getTime()) {
    throw new AcademyError('Video URL grant has expired', 'academy.video_grant_required');
  }
  const objectKey = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').split('/').slice(1).join('/'));
  const issued = signGetObjectUrl({ ...storage, ttlSeconds: expires }, objectKey, new Date(signedAt));
  const issuedUrl = new URL(issued.playbackUrl);
  const expected = issuedUrl.searchParams.get('X-Amz-Signature') ?? '';
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) {
    throw new AcademyError('Video URL grant signature does not match', 'academy.video_grant_required');
  }
}
