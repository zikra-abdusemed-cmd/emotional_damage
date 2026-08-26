import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAudioStorage } from '../src/storage.mjs';

test('manual audio folder lists supported files and ignores other files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'focus-audio-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'motivation-check.mp3'), 'fake');
  await writeFile(join(dir, 'notes.txt'), 'ignore me');

  const storage = new LocalAudioStorage(dir);
  const audio = await storage.listManualFiles();

  assert.equal(audio.length, 1);
  assert.equal(audio[0].name, 'Motivation Check');
  assert.equal(audio[0].category, 'MOTIVATION');
  assert.equal(audio[0].mimeType, 'audio/mpeg');
  assert.match(audio[0].streamUrl, /^\/api\/audio\/.+\/file$/);
});

test('manual audio lookup rejects unsafe ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'focus-audio-'));
  const storage = new LocalAudioStorage(dir);

  assert.equal(await storage.manualFileById(Buffer.from('../secret.mp3').toString('base64url')), null);
  assert.equal(await storage.manualFileById(Buffer.from('not-audio.txt').toString('base64url')), null);
});
