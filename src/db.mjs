import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const initialData = () => ({
  tasks: [],
  focusSessions: [],
  stats: {
    visitors: 0,
    completed: 0,
    lastSeen: {}
  }
});

export class JsonDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const text = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return initialData();
      const stats = parsed.stats && typeof parsed.stats === 'object' && !Array.isArray(parsed.stats)
        ? parsed.stats
        : initialData().stats;
      return {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        focusSessions: Array.isArray(parsed.focusSessions) ? parsed.focusSessions : [],
        stats
      };
    } catch (error) {
      if (error.code === 'ENOENT') return initialData();
      throw error;
    }
  }

  async write(data) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }

  async update(mutator) {
    this.queue = this.queue.then(async () => {
      const data = await this.read();
      const result = await mutator(data);
      await this.write(data);
      return result;
    });
    return this.queue;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
