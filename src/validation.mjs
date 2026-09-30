export function jsonError(message, status = 400, code = 'BAD_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function parseJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(jsonError('Request body is too large.', 413, 'BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(jsonError('Invalid JSON body.', 400, 'INVALID_JSON'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(jsonError('Invalid JSON body.', 400, 'INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function normalizeTitle(title) {
  if (typeof title !== 'string') {
    throw jsonError('Task title is required.');
  }
  const trimmed = title.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 1) {
    throw jsonError('Task title cannot be empty.');
  }
  if (trimmed.length > 160) {
    throw jsonError('Task title must be 160 characters or fewer.');
  }
  return trimmed;
}

export function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  throw jsonError('Invalid boolean value.', 400, 'INVALID_BOOLEAN');
}
