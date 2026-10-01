import { randomUUID } from 'node:crypto';
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

function normalizeData(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return initialData();
  const stats = parsed.stats && typeof parsed.stats === 'object' && !Array.isArray(parsed.stats)
    ? parsed.stats
    : initialData().stats;
  return {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    focusSessions: Array.isArray(parsed.focusSessions) ? parsed.focusSessions : [],
    stats
  };
}

export class JsonDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      return normalizeData(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return initialData();
      throw error;
    }
  }

  async write(data) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }

  async update(mutator) {
    const update = this.queue.catch(() => {}).then(async () => {
      const data = await this.read();
      const result = await mutator(data);
      await this.write(data);
      return result;
    });
    this.queue = update;
    return update;
  }
}

// Keeps the whole store in memory and saves it to Upstash Redis (REST API) a few
// seconds after each change, so free-tier hosts without a persistent disk work.
// Only safe with a single app instance.
export class UpstashDatabase {
  constructor({ url, token, key = 'do-the-damn-thing:db', flushDelayMs = 3000, fetchImpl = globalThis.fetch }) {
    this.url = String(url).replace(/\/+$/, '');
    this.token = token;
    this.key = key;
    this.flushDelayMs = flushDelayMs;
    this.fetch = fetchImpl;
    this.queue = Promise.resolve();
    this.text = null;
    this.loading = null;
    this.dirty = false;
    this.timer = null;
    this.flushing = Promise.resolve();
  }

  async command(args) {
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(args)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      throw new Error(`Upstash ${args[0]} failed: ${payload.error || response.status}`);
    }
    return payload.result;
  }

  async load() {
    if (this.text !== null) return;
    this.loading ||= this.command(['GET', this.key]).then((stored) => {
      this.text = typeof stored === 'string' ? stored : JSON.stringify(initialData());
    }).finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  async read() {
    await this.load();
    return normalizeData(JSON.parse(this.text));
  }

  async write(data) {
    this.text = JSON.stringify(data);
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush().catch((error) => console.error(error));
      }, this.flushDelayMs);
      this.timer.unref?.();
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing = this.flushing.catch(() => {}).then(async () => {
      if (!this.dirty) return;
      const text = this.text;
      this.dirty = false;
      try {
        await this.command(['SET', this.key, text]);
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    });
    return this.flushing;
  }

  async update(mutator) {
    const update = this.queue.catch(() => {}).then(async () => {
      const data = await this.read();
      const result = await mutator(data);
      await this.write(data);
      return result;
    });
    this.queue = update;
    return update;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}
