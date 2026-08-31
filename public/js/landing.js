function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '0';
  return new Intl.NumberFormat().format(Math.floor(number));
}

function renderStats(payload) {
  const visitors = document.getElementById('statVisitors');
  const active = document.getElementById('statActive');
  const crossed = document.getElementById('statCrossed');
  if (!visitors || !active || !crossed) return;
  visitors.textContent = formatCount(payload.visitors);
  active.textContent = formatCount(payload.activeUsers);
  crossed.textContent = formatCount(payload.crossedOff);
}

async function loadStats() {
  try {
    const response = await fetch('/api/stats', { credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return;
    renderStats(payload);
  } catch {
    // keep placeholders when the stats endpoint is unavailable
  }
}

loadStats();
setInterval(loadStats, 30_000);
