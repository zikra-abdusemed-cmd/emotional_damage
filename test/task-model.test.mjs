import test from 'node:test';
import assert from 'node:assert/strict';
import { nextIncompleteTask, normalizeTaskPositions, reorderTasks } from '../src/tasks.mjs';

function task(id, position, completed = false) {
  return {
    id,
    userId: 'local-user',
    title: id,
    position,
    completed,
    createdAt: `2026-01-01T00:00:0${position}.000Z`,
    completedAt: completed ? '2026-01-01T00:01:00.000Z' : null
  };
}

test('normalizes task ordering with incomplete tasks first', () => {
  const result = normalizeTaskPositions([task('done', 1, true), task('open', 2)]);
  assert.deepEqual(result.map((item) => item.id), ['open', 'done']);
  assert.deepEqual(result.map((item) => item.position), [1, 2]);
});

test('reorders tasks and persists positions', () => {
  const result = reorderTasks([task('a', 1), task('b', 2), task('c', 3)], ['c', 'a']);
  assert.deepEqual(result.map((item) => item.id), ['c', 'a', 'b']);
  assert.deepEqual(result.map((item) => item.position), [1, 2, 3]);
});

test('selects the next incomplete task after completion', () => {
  const result = nextIncompleteTask([task('a', 1, true), task('b', 2), task('c', 3)]);
  assert.equal(result.id, 'b');
});

test('returns null when all tasks are complete', () => {
  assert.equal(nextIncompleteTask([task('a', 1, true)]), null);
});
