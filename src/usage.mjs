import { readFile } from 'node:fs/promises';

function costTier(driver) { return typeof driver.cost === 'object' ? driver.cost.tier : driver.cost; }
function timestamp(event) { const value = Date.parse(event.at || ''); return Number.isFinite(value) ? value : null; }

export function aggregateUsage(events, fleet, { week = null, nowMs = Date.now() } = {}) {
  const cutoff = week == null ? null : nowMs - Number(week) * 7 * 24 * 60 * 60 * 1000;
  const tasks = new Map();
  for (const event of events) {
    const at = timestamp(event); if (cutoff != null && (at == null || at < cutoff)) continue;
    if (!event.task_id) continue; const item = tasks.get(event.task_id) || { task_id: event.task_id, created: at, start: null, end: null, driver: null, status: null, latest: at };
    if (event.driver) { item.driver = event.driver; item.start ??= at; } if (at != null) { item.created ??= at; item.latest = Math.max(item.latest || at, at); }
    if (event.type === 'task.transition' && ['succeeded', 'verified', 'failed', 'rejected', 'done'].includes(event.status)) { item.status = event.status; item.end = at; }
    tasks.set(event.task_id, item);
  }
  const rows = new Map(fleet.drivers.map((driver) => [driver.name, { driver: driver.name, tasks: 0, succeeded: 0, failed: 0, duration_seconds: 0, latest_at: null, ...(costTier(driver) === 'paid-fixed' ? { rate_limit_note: driver.rate_limit_note || driver.rate_limit || '未配置限速事实' } : {}) }]));
  for (const task of tasks.values()) {
    if (!task.driver || !rows.has(task.driver)) continue; const row = rows.get(task.driver); row.tasks += 1;
    if (['succeeded', 'verified', 'done'].includes(task.status)) row.succeeded += 1; if (['failed', 'rejected'].includes(task.status)) row.failed += 1;
    const started = task.start ?? task.created;
    if (started != null && task.end != null) row.duration_seconds += Math.max(0, Math.round((task.end - started) / 1000));
    if (task.latest != null && (!row.latest_at || task.latest > Date.parse(row.latest_at))) row.latest_at = new Date(task.latest).toISOString();
  }
  return [...rows.values()].sort((a, b) => a.driver.localeCompare(b.driver));
}

export async function usageFromEvents(file, fleet, options = {}) {
  let content = ''; try { content = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const events = content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return aggregateUsage(events, fleet, options);
}
