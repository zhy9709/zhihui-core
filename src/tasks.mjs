import { join } from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';
import { appendEvent, atomicWriteJson, readJson } from './state.mjs';

const TRANSITIONS = {
  queued: new Set(['locked']),
  locked: new Set(['queued', 'running', 'dispatched', 'failed', 'unknown']),
  running: new Set(['done', 'succeeded', 'failed', 'unknown']),
  dispatched: new Set(['done', 'failed', 'unknown', 'verified', 'rejected']),
  unknown: new Set(['done', 'failed']),
  succeeded: new Set(['verified', 'rejected']),
  verified: new Set(), rejected: new Set(), done: new Set(), failed: new Set()
};

export class TaskConflictError extends Error {
  constructor(taskId) { super(`task-id ${taskId} already exists (idempotency conflict)`); this.code = 'IDEMPOTENCY_CONFLICT'; }
}

export class TaskStateError extends Error {}

export class TaskStore {
  constructor(dataDir = 'state', { now = () => new Date().toISOString() } = {}) {
    this.dataDir = dataDir;
    this.now = now;
    this.tasksDir = join(dataDir, 'tasks');
    this.locksDir = join(dataDir, 'locks');
    this.eventsFile = join(dataDir, 'events.ndjson');
  }

  taskPath(taskId) { return join(this.tasksDir, `${taskId}.json`); }
  lockPath(taskId) { return join(this.locksDir, `${taskId}.json`); }
  async get(taskId) { return readJson(this.taskPath(taskId), null); }

  async create({ task_id, payload = {} }) {
    if (!/^[A-Za-z0-9._-]+$/.test(task_id || '')) throw new TaskStateError('task-id must contain only letters, digits, dot, underscore, or dash');
    if (await this.get(task_id)) throw new TaskConflictError(task_id);
    const task = { task_id, payload, status: 'queued', created_at: this.now(), updated_at: this.now(), heartbeat_at: null };
    await atomicWriteJson(this.taskPath(task_id), task);
    await appendEvent(this.eventsFile, { type: 'task.created', task_id, at: this.now() });
    return task;
  }

  async transition(taskId, next, patch = {}) {
    const task = await this.get(taskId);
    if (!task) throw new TaskStateError(`task-id ${taskId} does not exist`);
    if (!TRANSITIONS[task.status]?.has(next)) throw new TaskStateError(`invalid transition ${task.status} -> ${next}`);
    task.status = next; task.updated_at = this.now();
    Object.assign(task, patch);
    if (next === 'running') task.heartbeat_at = this.now();
    await atomicWriteJson(this.taskPath(taskId), task);
    if (next === 'locked' || next === 'running') await atomicWriteJson(this.lockPath(taskId), { task_id: taskId, status: next, heartbeat_at: task.heartbeat_at, updated_at: task.updated_at });
    else await rm(this.lockPath(taskId), { force: true });
    await appendEvent(this.eventsFile, { type: 'task.transition', task_id: taskId, status: next, at: this.now(), ...patch });
    return task;
  }

  async annotate(taskId, patch, type = 'task.annotated') {
    const task = await this.get(taskId);
    if (!task) throw new TaskStateError(`task-id ${taskId} does not exist`);
    Object.assign(task, patch, { updated_at: this.now() });
    await atomicWriteJson(this.taskPath(taskId), task);
    await appendEvent(this.eventsFile, { type, task_id: taskId, at: this.now(), ...patch });
    return task;
  }

  async event(type, taskId, fields = {}) {
    await appendEvent(this.eventsFile, { type, task_id: taskId, at: this.now(), ...fields });
  }

  async list() {
    let files = [];
    try { files = await readdir(this.tasksDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return Promise.all(files.filter((name) => name.endsWith('.json')).sort().map((file) => readJson(join(this.tasksDir, file), null)));
  }

  async heartbeat(taskId) {
    const task = await this.get(taskId);
    if (!task || task.status !== 'running') throw new TaskStateError(`task-id ${taskId} is not running`);
    task.heartbeat_at = task.updated_at = this.now();
    await atomicWriteJson(this.taskPath(taskId), task);
    await atomicWriteJson(this.lockPath(taskId), { task_id: taskId, status: 'running', heartbeat_at: task.heartbeat_at });
    await appendEvent(this.eventsFile, { type: 'task.heartbeat', task_id: taskId, at: task.heartbeat_at });
    return task;
  }

  async recover({ staleAfterMs = 5 * 60 * 1000, nowMs = Date.now() } = {}) {
    let files = [];
    try { files = await readdir(this.locksDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const recovered = [];
    for (const file of files.filter((name) => name.endsWith('.json'))) {
      const lock = await readJson(join(this.locksDir, file), null);
      if (!lock) continue;
      const task = await this.get(lock.task_id);
      let heartbeat = Date.parse(task?.heartbeat_at || lock.heartbeat_at || 0);
      if (task?.heartbeat_file) {
        try { heartbeat = (await stat(task.heartbeat_file)).mtimeMs; }
        catch (error) { if (error.code === 'ENOENT') heartbeat = 0; else throw error; }
      }
      if (task?.status === 'locked') {
        await this.transition(task.task_id, 'queued', { recovery: 'locked-without-running' });
        recovered.push(task.task_id);
      } else if (task?.status === 'running' && (!Number.isFinite(heartbeat) || nowMs - heartbeat > staleAfterMs)) {
        await this.transition(task.task_id, 'unknown');
        recovered.push(task.task_id);
      }
    }
    return recovered;
  }
}
