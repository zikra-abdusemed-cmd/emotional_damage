import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const initialData = () => ({
  tasks: [],
  focusSessions: []
});

export class JsonDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const text = await readFile(this.filePath, 'utf8');
      return { ...initialData(), ...JSON.parse(text) };
    } catch (error) {
      if (error.code === 'ENOENT') return initialData();
      throw error;
    }
  }

  async write(data) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`);
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
