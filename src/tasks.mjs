export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
    return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
  });
}

export function normalizeTaskPositions(tasks) {
  return sortTasks(tasks).map((task, index) => ({
    ...task,
    position: index + 1
  }));
}

export function nextIncompleteTask(tasks) {
  return sortTasks(tasks).find((task) => !task.completed) || null;
}

export function reorderTasks(tasks, orderedIds) {
  const requested = Array.isArray(orderedIds) ? orderedIds : [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set();
  const reordered = [];

  for (const id of requested) {
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    reordered.push(byId.get(id));
  }

  for (const task of sortTasks(tasks)) {
    if (!seen.has(task.id)) reordered.push(task);
  }

  return reordered.map((task, index) => ({
    ...task,
    position: index + 1
  }));
}
