import {
  FOCUSING_SETTINGS,
  NotificationManager,
  RecentAudioSelector,
  ReminderScheduler,
  SESSION_STATUSES,
  WARMUP_SETTINGS,
  focusNotificationCopy
} from './focus-core.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  tasks: [],
  audio: [],
  session: null,
  activeTask: null,
  reminderPhase: 'warmup'
};

const els = {
  alert: $('#alert'),
  activeTaskTitle: $('#activeTaskTitle'),
  sessionState: $('#sessionState'),
  startFocus: $('#startFocus'),
  pauseFocus: $('#pauseFocus'),
  resumeFocus: $('#resumeFocus'),
  stopFocus: $('#stopFocus'),
  taskForm: $('#taskForm'),
  taskTitle: $('#taskTitle'),
  taskList: $('#taskList'),
  completedWrap: $('#completedWrap'),
  completedList: $('#completedList'),
  statusClock: $('#statusClock')
};

const audioSelector = new RecentAudioSelector({ historySize: 12 });
const notifications = new NotificationManager();
const player = new Audio();
player.preload = 'auto';
player.volume = WARMUP_SETTINGS.volume;

const scheduler = new ReminderScheduler({
  getSettings: () => (state.reminderPhase === 'warmup' ? WARMUP_SETTINGS : FOCUSING_SETTINGS),
  onReminder: () => triggerReminder(),
  onFocusNudge: () => showFocusNotification()
});

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || 'Request failed.');
  }
  return payload;
}

function showAlert(message) {
  els.alert.textContent = message;
  els.alert.hidden = false;
  clearTimeout(showAlert.timer);
  showAlert.timer = setTimeout(() => {
    els.alert.hidden = true;
  }, 5000);
}

function splitTasks() {
  return {
    open: state.tasks.filter((task) => !task.completed),
    completed: state.tasks.filter((task) => task.completed)
  };
}

function sessionLabel(status) {
  if (status === SESSION_STATUSES.FOCUSING) return 'Focusing';
  if (status === SESSION_STATUSES.PAUSED) return 'Paused';
  if (status === SESSION_STATUSES.COMPLETED) return 'Completed';
  if (status === SESSION_STATUSES.ENDED) return 'Stopped';
  return 'Idle';
}

function render() {
  renderFocus();
  renderTasks();
}

function renderFocus() {
  const status = state.session?.status || SESSION_STATUSES.IDLE;
  const activeTitle = state.activeTask?.title
    || (state.tasks.some((task) => !task.completed) ? 'Ready when you are.' : 'Add a task to begin.');
  els.activeTaskTitle.textContent = activeTitle;
  els.sessionState.textContent = sessionLabel(status);
  els.startFocus.hidden = status === SESSION_STATUSES.FOCUSING || status === SESSION_STATUSES.PAUSED;
  els.pauseFocus.hidden = status !== SESSION_STATUSES.FOCUSING;
  els.resumeFocus.hidden = status !== SESSION_STATUSES.PAUSED;
  els.stopFocus.hidden = !(status === SESSION_STATUSES.FOCUSING || status === SESSION_STATUSES.PAUSED);
}

function renderTasks() {
  const { open, completed } = splitTasks();
  els.taskList.replaceChildren(...open.map((task) => taskElement(task, els.taskList)));
  els.completedWrap.hidden = completed.length === 0;
  els.completedList.replaceChildren(...completed.map((task) => taskElement(task, els.completedList)));
}


function taskElement(task, listEl) {
  const li = document.createElement('li');
  li.className = `task-row${task.id === state.activeTask?.id ? ' active' : ''}${task.completed ? ' completed' : ''}`;
  li.draggable = !task.completed;
  li.dataset.id = task.id;

  const handle = document.createElement('button');
  handle.className = 'btn drag-handle';
  handle.type = 'button';
  handle.title = 'Drag to reorder';
  handle.textContent = '↕';

  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = task.title;

  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const complete = document.createElement('button');
  complete.className = 'btn';
  complete.type = 'button';
  complete.title = task.completed ? 'Completed' : 'Cross off';
  complete.textContent = task.completed ? '✓' : '□';
  complete.disabled = task.completed;
  complete.addEventListener('click', () => completeTask(task.id));

  const edit = document.createElement('button');
  edit.className = 'btn';
  edit.type = 'button';
  edit.title = 'Edit task';
  edit.textContent = '✎';
  edit.addEventListener('click', () => editTask(task, title));

  actions.append(complete, edit);
  li.append(handle, title, actions);

  li.addEventListener('dragstart', (event) => {
    li.classList.add('dragging');
    event.dataTransfer.setData('text/plain', task.id);
    event.dataTransfer.effectAllowed = 'move';
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (event) => {
    event.preventDefault();
    const dragging = listEl.querySelector('.dragging');
    if (!dragging || dragging === li) return;
    const rect = li.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    listEl.insertBefore(dragging, after ? li.nextSibling : li);
  });
  li.addEventListener('drop', (event) => {
    event.preventDefault();
    if (listEl === els.taskList) persistDragOrder();
  });

  return li;
}

async function persistDragOrder() {
  const orderedIds = [...els.taskList.querySelectorAll('.task-row')].map((item) => item.dataset.id);
  try {
    const payload = await api('/api/tasks/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ orderedIds })
    });
    state.tasks = payload.tasks;
    render();
  } catch (error) {
    showAlert(error.message);
    await loadAll();
  }
}

async function editTask(task, titleEl) {
  if (titleEl.contentEditable === 'true') return;
  titleEl.contentEditable = 'true';
  titleEl.focus();
  document.getSelection().selectAllChildren(titleEl);

  const finish = async (restore = false) => {
    titleEl.contentEditable = 'false';
    titleEl.removeEventListener('blur', onBlur);
    titleEl.removeEventListener('keydown', onKey);
    if (restore) {
      titleEl.textContent = task.title;
      return;
    }
    const title = titleEl.textContent.trim();
    if (!title || title === task.title) {
      titleEl.textContent = task.title;
      return;
    }
    try {
      const payload = await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title })
      });
      applyCurrent(payload.current);
    } catch (error) {
      showAlert(error.message);
      titleEl.textContent = task.title;
    }
  };

  const onBlur = () => finish(false);
  const onKey = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(false);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(true);
    }
  };

  titleEl.addEventListener('blur', onBlur);
  titleEl.addEventListener('keydown', onKey);
}

function resetReminderPhase() {
  state.reminderPhase = 'warmup';
}

function applyCurrent(current) {
  state.session = current.session;
  state.activeTask = current.activeTask;
  state.tasks = current.tasks || state.tasks;
  syncScheduler();
  render();
}

function syncScheduler() {
  if (state.session?.status === SESSION_STATUSES.FOCUSING) {
    scheduler.start();
    return;
  }
  scheduler.stop();
}

function prioritizedTask() {
  return state.activeTask || state.tasks.find((task) => !task.completed) || null;
}

function showFocusNotification() {
  const task = prioritizedTask();
  if (!task || state.session?.status !== SESSION_STATUSES.FOCUSING) return false;
  return notifications.show(focusNotificationCopy(task.title));
}

async function ensureNotificationPermission() {
  const permission = await notifications.requestPermission();
  if (permission === 'denied') {
    showAlert('Enable notifications in Chrome, Edge, or Safari so reminders can name your prioritized task.');
  }
  return permission;
}

async function triggerReminder() {
  const activeTask = prioritizedTask();
  if (!activeTask || state.session?.status !== SESSION_STATUSES.FOCUSING) return;
  await loadAudio();
  const selected = audioSelector.select(state.audio);
  state.reminderPhase = 'focusing';
  showFocusNotification();

  if (selected) {
    try {
      await playAudio(selected);
    } catch (error) {
      showAlert(`Voice playback failed: ${error.message}`);
    }
  } else {
    showAlert('No audio files found in the audio folder.');
  }
}

async function playAudio(audio) {
  player.pause();
  player.currentTime = 0;
  player.src = audio.streamUrl;
  player.volume = FOCUSING_SETTINGS.volume;
  player.load();
  await player.play();
}

async function startFocus() {
  try {
    await loadAudio();
    if (state.audio.length === 0) {
      showAlert('Add voice files to the audio folder before starting.');
      return;
    }
    resetReminderPhase();
    await ensureNotificationPermission();
    const current = await api('/api/focus/start', {
      method: 'POST',
      body: JSON.stringify({})
    });
    applyCurrent(current);
    showFocusNotification();
  } catch (error) {
    showAlert(error.message);
  }
}

async function pauseFocus() {
  try {
    const current = await api('/api/focus/pause', { method: 'POST', body: JSON.stringify({}) });
    applyCurrent(current);
  } catch (error) {
    showAlert(error.message);
  }
}

async function resumeFocus() {
  try {
    resetReminderPhase();
    await ensureNotificationPermission();
    const current = await api('/api/focus/resume', {
      method: 'POST',
      body: JSON.stringify({})
    });
    applyCurrent(current);
    showFocusNotification();
  } catch (error) {
    showAlert(error.message);
  }
}

async function stopFocus() {
  try {
    scheduler.stop();
    player.pause();
    const current = await api('/api/focus/end', { method: 'POST', body: JSON.stringify({}) });
    applyCurrent(current);
  } catch (error) {
    showAlert(error.message);
  }
}

async function completeTask(id) {
  try {
    const payload = await api(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed: true })
    });
    applyCurrent(payload.current);
  } catch (error) {
    showAlert(error.message);
  }
}

async function addTask(event) {
  event.preventDefault();
  const title = els.taskTitle.value.trim();
  if (!title) return;
  try {
    const payload = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title })
    });
    els.taskTitle.value = '';
    applyCurrent(payload.current);
  } catch (error) {
    showAlert(error.message);
  }
}


async function loadCurrent() {
  const current = await api('/api/focus/current');
  applyCurrent(current);
}

async function loadAudio() {
  const payload = await api('/api/audio');
  state.audio = payload.audio;
}

async function loadAll() {
  try {
    await Promise.all([loadAudio(), loadCurrent()]);
    render();
  } catch (error) {
    showAlert(`Backend unavailable: ${error.message}`);
  }
}

function bindEvents() {
  els.taskForm?.addEventListener('submit', addTask);
  els.startFocus?.addEventListener('click', startFocus);
  els.pauseFocus?.addEventListener('click', pauseFocus);
  els.resumeFocus?.addEventListener('click', resumeFocus);
  els.stopFocus?.addEventListener('click', stopFocus);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || state.session?.status !== SESSION_STATUSES.FOCUSING) return;
    scheduler.catchUp();
    scheduler.start();
  });
  window.addEventListener('beforeunload', () => scheduler.stop());
}

async function heartbeatPresence() {
  try {
    await api('/api/stats');
  } catch {
    // Presence is best-effort and does not interrupt focus sessions.
  }
}

function updateClock() {
  if (!els.statusClock) return;
  els.statusClock.textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

bindEvents();
updateClock();
setInterval(updateClock, 30_000);
loadAll();
setInterval(heartbeatPresence, 30_000);
