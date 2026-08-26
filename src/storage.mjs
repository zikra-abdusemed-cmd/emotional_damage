import { mkdir, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const extensionMimeTypes = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.ogg', 'audio/ogg']
]);

const categories = [
  'GENERAL',
  'DISTRACTION',
  'MOTIVATION',
  'ANGRY',
  'EMOTIONAL_DAMAGE',
  'LONG_SESSION',
  'TASK_COMPLETE',
  'START'
];

function titleFromFilename(filename) {
  return basename(filename, extname(filename))
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'Audio reminder';
}

function categoryFromFilename(filename) {
  const normalized = filename.toUpperCase().replace(/[-\s]+/g, '_');
  return categories.find((category) => normalized.includes(category)) || 'GENERAL';
}

function encodeKey(filename) {
  return Buffer.from(filename, 'utf8').toString('base64url');
}

function decodeKey(key) {
  return Buffer.from(String(key || ''), 'base64url').toString('utf8');
}

export class LocalAudioStorage {
  constructor(rootDir) {
    this.rootDir = resolve(rootDir);
  }

  async listManualFiles() {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const audioFiles = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      const mimeType = extensionMimeTypes.get(extension);
      if (!mimeType) continue;
      const info = await stat(this.resolveManualFilename(entry.name));
      audioFiles.push({
        id: encodeKey(entry.name),
        name: titleFromFilename(entry.name),
        category: categoryFromFilename(entry.name),
        duration: null,
        mimeType,
        enabled: true,
        createdAt: info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
        filename: entry.name,
        streamUrl: `/api/audio/${encodeKey(entry.name)}/file`
      });
    }
    return audioFiles.sort((a, b) => a.name.localeCompare(b.name));
  }

  async manualFileById(id) {
    const filename = decodeKey(id);
    if (!filename || filename !== basename(filename)) return null;
    const extension = extname(filename).toLowerCase();
    const mimeType = extensionMimeTypes.get(extension);
    if (!mimeType) return null;
    try {
      const info = await stat(this.resolveManualFilename(filename));
      if (!info.isFile()) return null;
      return {
        id,
        name: titleFromFilename(filename),
        category: categoryFromFilename(filename),
        duration: null,
        mimeType,
        enabled: true,
        createdAt: info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
        filename,
        streamUrl: `/api/audio/${id}/file`
      };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  streamManualFile(filename) {
    return createReadStream(this.resolveManualFilename(filename));
  }

  resolveManualFilename(filename) {
    const safeName = basename(String(filename || ''));
    if (safeName !== filename || !extensionMimeTypes.has(extname(safeName).toLowerCase())) {
      throw new Error('Invalid audio filename.');
    }
    const path = resolve(join(this.rootDir, safeName));
    if (!path.startsWith(`${this.rootDir}/`)) {
      throw new Error('Invalid audio path.');
    }
    return path;
  }
}
