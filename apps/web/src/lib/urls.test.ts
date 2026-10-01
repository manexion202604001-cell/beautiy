import { describe, expect, it } from 'vitest';
import { sameOriginApiUrl } from './urls';

describe('sameOriginApiUrl', () => {
  it('rewrites cross-origin API file URLs to the same-origin /v1 proxy path', () => {
    expect(sameOriginApiUrl('http://api.example.test:4202/v1/files/blob/abc?x=1')).toBe('/v1/files/blob/abc?x=1');
  });

  it('keeps foreign (e.g. S3 presigned) URLs and handles empty values', () => {
    expect(sameOriginApiUrl('https://bucket.s3.amazonaws.com/a.svg?X-Amz=1')).toBe(
      'https://bucket.s3.amazonaws.com/a.svg?X-Amz=1',
    );
    expect(sameOriginApiUrl(null)).toBeNull();
    expect(sameOriginApiUrl('')).toBeNull();
  });
});
