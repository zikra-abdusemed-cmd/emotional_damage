import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

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
  const base = filename.split(/[/\\]/).pop() || filename;
  return base.replace(/\.[^.]+$/, '')
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

function posixRelative(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isSafeRelativeAudio(relativePath) {
  const normalized = posixRelative(relativePath);
  if (!normalized || normalized.includes('\0')) return false;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  return extensionMimeTypes.has(extname(normalized).toLowerCase());
}

export class LocalAudioStorage {
  constructor(rootDir) {
    this.rootDir = resolve(rootDir);
  }

  async listManualFiles(relativeDir = '') {
    await mkdir(this.rootDir, { recursive: true });
    const currentDir = relativeDir
      ? this.resolveManualFilename(relativeDir, { directory: true })
      : this.rootDir;
    const entries = await readdir(currentDir, { withFileTypes: true });
    const audioFiles = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = relativeDir ? `${posixRelative(relativeDir)}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        audioFiles.push(...await this.listManualFiles(rel));
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      const fallbackMimeType = extensionMimeTypes.get(extension);
      if (!fallbackMimeType) continue;
      const mimeType = await this.mimeTypeFor(rel, fallbackMimeType);
      const info = await stat(this.resolveManualFilename(rel));
      audioFiles.push(this.describe(rel, mimeType, info));
    }
    return audioFiles.sort((a, b) => a.name.localeCompare(b.name) || a.filename.localeCompare(b.filename));
  }

  async manualFileById(id) {
    const filename = decodeKey(id);
    if (!isSafeRelativeAudio(filename)) return null;
    try {
      const info = await stat(this.resolveManualFilename(filename));
      if (!info.isFile()) return null;
      return this.describe(
        filename,
        await this.mimeTypeFor(filename, extensionMimeTypes.get(extname(filename).toLowerCase())),
        info
      );
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  streamManualFile(filename) {
    return createReadStream(this.resolveManualFilename(filename));
  }

  describe(filename, mimeType, info) {
    const id = encodeKey(filename);
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
  }

  async mimeTypeFor(filename, fallback) {
    const header = await readFile(this.resolveManualFilename(filename), { encoding: null, flag: 'r' });
    if (header.length >= 12 && header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WAVE') {
      return 'audio/wav';
    }
    return fallback;
  }

  resolveManualFilename(filename, { directory = false } = {}) {
    const relativePath = posixRelative(filename);
    const parts = relativePath.split('/');
    if (!relativePath || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Invalid audio filename.');
    }
    if (!directory && !extensionMimeTypes.has(extname(relativePath).toLowerCase())) {
      throw new Error('Invalid audio filename.');
    }
    const path = resolve(join(this.rootDir, ...parts));
    const prefix = this.rootDir.endsWith(sep) ? this.rootDir : `${this.rootDir}${sep}`;
    if (path !== this.rootDir && !path.startsWith(prefix)) {
      throw new Error('Invalid audio path.');
    }
    if (relative(this.rootDir, path).startsWith('..')) {
      throw new Error('Invalid audio path.');
    }
    return path;
  }
}
