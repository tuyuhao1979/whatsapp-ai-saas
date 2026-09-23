import * as Minio from 'minio';
import type { IStoragePort, UploadInput } from '../../domain/ports/IStoragePort.js';
import { ExternalServiceError } from '../../domain/errors.js';

export interface MinioConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface NormalisedEndpoint {
  host: string;
  port: number;
  useSSL: boolean;
}

/**
 * The minio SDK takes a bare hostname in `endPoint` plus a separate `port`;
 * handing it a URL makes the constructor throw InvalidEndpointError and the
 * whole service fails to boot.
 *
 * S3_ENDPOINT is documented (and shipped in infra/.env.example and
 * docker-compose) as http://minio:9000, so the accepted forms are:
 *   http://minio:9000   (URL with scheme and port)
 *   https://s3.example  (URL with scheme, default port)
 *   minio:9000          (bare host:port)
 *   minio               (bare host)
 * A scheme decides TLS; an explicit URL port wins over the configured port.
 */
export function normaliseEndpoint(
  rawEndpoint: string,
  fallbackPort: number,
  fallbackUseSSL: boolean,
): NormalisedEndpoint {
  const raw = rawEndpoint.trim();

  if (raw.includes('://')) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`Invalid S3_ENDPOINT: ${rawEndpoint}`);
    }
    if (!url.hostname) {
      throw new Error(`Invalid S3_ENDPOINT: ${rawEndpoint}`);
    }
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : fallbackPort,
      useSSL: url.protocol === 'https:',
    };
  }

  const separator = raw.lastIndexOf(':');
  if (separator > 0) {
    const host = raw.slice(0, separator);
    const parsed = Number(raw.slice(separator + 1));
    if (host && Number.isInteger(parsed) && parsed > 0) {
      return { host, port: parsed, useSSL: fallbackUseSSL };
    }
  }

  return { host: raw, port: fallbackPort, useSSL: fallbackUseSSL };
}

export class MinioStorageAdapter implements IStoragePort {
  private readonly client: Minio.Client;
  private readonly bucket: string;

  constructor(config: MinioConfig) {
    const { host, port, useSSL } = normaliseEndpoint(
      config.endPoint,
      config.port,
      config.useSSL,
    );
    this.client = new Minio.Client({
      endPoint: host,
      port,
      useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
    this.bucket = config.bucket;
  }

  /**
   * Streams the upload directly to MinIO without buffering in memory.
   * Returns the storageUri: `kb-documents/{tenantId}/{documentId}/{filename}`
   */
  async upload(input: UploadInput): Promise<string> {
    const objectName = `kb-documents/${input.tenantId}/${input.documentId}/${input.filename}`;
    const metaData = { 'Content-Type': input.contentType };

    try {
      await this.client.putObject(
        this.bucket,
        objectName,
        input.stream,
        input.size,
        metaData,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ExternalServiceError('MinIO', `Upload failed: ${message}`);
    }

    return `s3://${this.bucket}/${objectName}`;
  }

  async delete(storageUri: string): Promise<void> {
    const objectName = this.parseObjectName(storageUri);
    try {
      await this.client.removeObject(this.bucket, objectName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ExternalServiceError('MinIO', `Delete failed: ${message}`);
    }
  }

  async getSignedUrl(storageUri: string, expirySeconds: number): Promise<string> {
    const objectName = this.parseObjectName(storageUri);
    try {
      return await this.client.presignedGetObject(this.bucket, objectName, expirySeconds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ExternalServiceError('MinIO', `Presign failed: ${message}`);
    }
  }

  private parseObjectName(storageUri: string): string {
    // Strip s3://bucket/ prefix
    const prefix = `s3://${this.bucket}/`;
    if (!storageUri.startsWith(prefix)) {
      throw new Error(`Invalid storageUri: ${storageUri}`);
    }
    return storageUri.slice(prefix.length);
  }
}
