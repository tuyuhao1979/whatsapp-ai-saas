import type { FastifyPluginAsync } from 'fastify';
import type { UploadDocumentUseCase } from '../../../application/kb/UploadDocumentUseCase.js';
import type { ListDocumentsUseCase } from '../../../application/kb/ListDocumentsUseCase.js';
import type { DeleteDocumentUseCase } from '../../../application/kb/DeleteDocumentUseCase.js';
import { ok, sendDomainError, unsupportedMediaType } from '../reply.js';
import { ValidationError } from '../../../domain/errors.js';
import { requireUuidParam } from '../validation.js';

interface KbRoutesDeps {
  uploadDocumentUseCase: UploadDocumentUseCase;
  listDocumentsUseCase: ListDocumentsUseCase;
  deleteDocumentUseCase: DeleteDocumentUseCase;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const kbRoutes: FastifyPluginAsync<KbRoutesDeps> = async (fastify, opts) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // Uploads and deletions mutate tenant data and enqueue indexing work;
  // require owner/admin (audit finding H5).
  const ownerOrAdmin = [fastify.authorize('owner', 'admin')];

  /** POST /api/v1/kb/documents (multipart) */
  fastify.post('/documents', { preHandler: ownerOrAdmin }, async (request, reply) => {
    if (!request.isMultipart()) {
      unsupportedMediaType(
        reply,
        'Expected multipart/form-data with a file part plus name and source_type fields',
      );
      return;
    }

    try {
      const data = await request.file({
        limits: { fileSize: MAX_FILE_SIZE },
      });

      if (!data) {
        throw new ValidationError('No file attached');
      }

      const name = data.fields['name'];
      const sourceType = data.fields['source_type'];

      const nameValue = typeof name === 'object' && 'value' in name ? name.value : undefined;
      const sourceTypeValue =
        typeof sourceType === 'object' && 'value' in sourceType ? sourceType.value : undefined;

      if (!nameValue) throw new ValidationError("Field 'name' is required");
      if (!sourceTypeValue) throw new ValidationError("Field 'source_type' is required");

      const doc = await opts.uploadDocumentUseCase.execute({
        tenantId: request.tenantId,
        name: nameValue as string,
        sourceType: sourceTypeValue as string,
        stream: data.file,
        filename: data.filename,
        contentType: data.mimetype,
      });

      ok(reply, { id: doc.id, status: doc.status }, 201);
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /** GET /api/v1/kb/documents */
  fastify.get('/documents', async (request, reply) => {
    try {
      const docs = await opts.listDocumentsUseCase.execute(request.tenantId);
      ok(reply, docs.map((d) => ({
        id: d.id,
        name: d.name,
        source_type: d.sourceType,
        status: d.status,
        chunk_count: d.chunkCount,
        uploaded_at: d.uploadedAt,
        indexed_at: d.indexedAt,
      })));
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /** DELETE /api/v1/kb/documents/:id */
  fastify.delete<{ Params: { id: string } }>(
    '/documents/:id',
    { preHandler: ownerOrAdmin },
    async (request, reply) => {
      const id = requireUuidParam(reply, request.params.id);
      if (id === null) return;

      try {
        await opts.deleteDocumentUseCase.execute(request.tenantId, id);
        ok(reply, null, 204);
      } catch (err) {
        sendDomainError(reply, err);
      }
    },
  );
};
