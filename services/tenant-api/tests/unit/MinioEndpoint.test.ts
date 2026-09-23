import {
  MinioStorageAdapter,
  normaliseEndpoint,
} from '../../src/infrastructure/storage/MinioStorageAdapter.js';

/**
 * Regression test for a boot-blocking defect.
 *
 * S3_ENDPOINT is documented as `http://minio:9000` (infra/.env.example, the
 * README table, and docker-compose all ship that form), but the adapter passed
 * it straight to `new Minio.Client({ endPoint })`. The SDK requires a bare
 * hostname there, so it threw
 *
 *   InvalidEndpointError: Invalid endPoint : http://minio:9000
 *
 * and tenant-api crashed on startup under the documented configuration — it
 * could never have run.
 */

describe('normaliseEndpoint', () => {
  it('accepts the documented URL form', () => {
    expect(normaliseEndpoint('http://minio:9000', 9000, false)).toEqual({
      host: 'minio',
      port: 9000,
      useSSL: false,
    });
  });

  it('derives TLS from the scheme', () => {
    expect(normaliseEndpoint('https://s3.example.com', 9000, false)).toEqual({
      host: 's3.example.com',
      port: 9000,
      useSSL: true,
    });
  });

  it('prefers an explicit URL port over the configured port', () => {
    expect(normaliseEndpoint('http://minio:9010', 9000, false)).toEqual({
      host: 'minio',
      port: 9010,
      useSSL: false,
    });
  });

  it('accepts a bare host:port', () => {
    expect(normaliseEndpoint('minio:9000', 9000, false)).toEqual({
      host: 'minio',
      port: 9000,
      useSSL: false,
    });
  });

  it('accepts a bare host and falls back to the configured port and TLS', () => {
    expect(normaliseEndpoint('minio', 9000, true)).toEqual({
      host: 'minio',
      port: 9000,
      useSSL: true,
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(normaliseEndpoint('  http://minio:9000  ', 9000, false).host).toBe('minio');
  });

  it('rejects a malformed URL instead of crashing later', () => {
    expect(() => normaliseEndpoint('http://', 9000, false)).toThrow(/Invalid S3_ENDPOINT/);
  });
});

describe('MinioStorageAdapter construction', () => {
  it('constructs against the documented S3_ENDPOINT value', () => {
    expect(
      () =>
        new MinioStorageAdapter({
          endPoint: 'http://minio:9000',
          port: 9000,
          useSSL: false,
          accessKey: 'key',
          secretKey: 'secret',
          bucket: 'kb-documents',
        }),
    ).not.toThrow();
  });

  it('constructs against a production https endpoint', () => {
    expect(
      () =>
        new MinioStorageAdapter({
          endPoint: 'https://s3.eu-west-1.amazonaws.com',
          port: 9000,
          useSSL: false,
          accessKey: 'key',
          secretKey: 'secret',
          bucket: 'kb-documents',
        }),
    ).not.toThrow();
  });
});
