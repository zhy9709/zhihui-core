import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

export class DispatchError extends Error {}

export function worktreePath(workspacesRoot, taskId) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId || '')) throw new DispatchError('unsafe task-id for worktree path');
  return resolve(workspacesRoot, taskId);
}

export function shellQuote(value, platform = 'linux') {
  const string = String(value);
  return platform === 'win' ? `"${string.replaceAll('"', '\\"')}"` : `'${string.replaceAll("'", "'\\\"'\\\"'")}'`;
}

export function renderLaunch(driver, task, ctx) {
  if (!driver.launch) throw new DispatchError(`driver ${driver.name} has no launch template`);
  const values = { brief: task.payload.brief || task.payload.brief_path || '', worktree: ctx.worktree, log: ctx.logFile };
  return driver.launch.replace(/\{(brief|worktree|log)\}/g, (_, key) => shellQuote(values[key], driver.platform));
}

async function defaultGit(args, options = {}) {
  const { stdout } = await execFileAsync('git', args, options);
  return stdout.trim();
}

async function countWorktrees(root) {
  try { return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

export async function prepare(task, driver, { workspacesRoot, maxWorktrees, git = defaultGit } = {}) {
  const root = workspacesRoot || task.payload.workspaces_root;
  if (!root) throw new DispatchError('workspaces_root must be configured');
  if (!task.payload.repo_path || !task.payload.base_ref) throw new DispatchError('task JSON requires repo_path and base_ref');
  if (maxWorktrees != null && await countWorktrees(root) >= maxWorktrees) throw new DispatchError(`max_worktrees (${maxWorktrees}) reached; refusing dispatch`);
  const path = worktreePath(root, task.task_id);
  await mkdir(root, { recursive: true });
  await git(['worktree', 'add', '-b', `fleet/${task.task_id}`, path, task.payload.base_ref], { cwd: task.payload.repo_path });
  return { worktree: path, branch: `fleet/${task.task_id}`, logFile: join(path, '.zhihui.log'), heartbeatFile: join(path, '.zhihui-heartbeat') };
}

async function touch(file) {
  const now = new Date();
  try { await utimes(file, now, now); } catch (error) { if (error.code === 'ENOENT') await writeFile(file, 'heartbeat\n'); else throw error; }
}

function localSpawn(command, platform, cwd) {
  return spawn(command, [], { cwd, shell: true, detached: true, windowsHide: true, stdio: 'ignore', ...(platform === 'win' ? { windowsVerbatimArguments: false } : {}) });
}

async function gitOutcome(task, ctx, git) {
  const base = task.payload.base_ref;
  const commits = Number(await git(['rev-list', '--count', `${base}..HEAD`], { cwd: ctx.worktree }));
  if (!commits) return { ok: false, reason: 'noop' };
  return { ok: true, commit: await git(['rev-parse', 'HEAD'], { cwd: ctx.worktree }) };
}

export async function launch(driver, task, ctx) {
  const { store, git = defaultGit, spawnProcess = localSpawn, sshRunner, killProcess = (pid) => process.kill(-pid, 'SIGTERM'), heartbeatIntervalMs = 10_000, timeoutMs = driver.timeout_min * 60_000, dry = false } = ctx;
  const command = renderLaunch(driver, task, ctx);
  if (dry) return { dry: true, command };
  if (driver.kind !== 'headless') throw new DispatchError('launch only supports headless drivers');
  if (driver.host !== 'local') {
    if (!sshRunner) throw new DispatchError(`remote driver ${driver.name} requires sshRunner`);
    await store.transition(task.task_id, 'running', { driver: driver.name, command });
    await store.event('launch.remote', task.task_id, { command, host: driver.host });
    const request = { host: driver.host, command, platform: driver.platform, task, ctx, operation: 'run' };
    let timer;
    const result = await Promise.race([
      Promise.resolve(sshRunner(request)),
      new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout({ timeout: true }), timeoutMs); })
    ]);
    clearTimeout(timer);
    if (result.timeout) {
      await sshRunner({ ...request, operation: 'cancel' });
      await store.event('kill.remote-timeout', task.task_id, { host: driver.host });
      await store.transition(task.task_id, 'failed', { reason: 'timeout' });
      return { command, timedOut: true };
    }
    if (result.code !== 0) { await store.transition(task.task_id, 'failed', { reason: 'exit-nonzero', exit_code: result.code }); return { command, result }; }
    if (!result.commit) { await store.transition(task.task_id, 'failed', { reason: 'noop' }); return { command, result }; }
    await store.transition(task.task_id, 'succeeded', { commit: result.commit });
    return { command, result };
  }
  await store.transition(task.task_id, 'running', { driver: driver.name, command, worktree: ctx.worktree, heartbeat_file: ctx.heartbeatFile });
  const child = spawnProcess(command, driver.platform, ctx.worktree);
  await store.annotate(task.task_id, { pid: child.pid }, 'launch.local');
  await touch(ctx.heartbeatFile);
  const heartbeat = setInterval(() => touch(ctx.heartbeatFile).catch(() => {}), heartbeatIntervalMs);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { killProcess(child.pid); } finally { store.event('kill.timeout', task.task_id, { pid: child.pid }).catch(() => {}); } }, timeoutMs);
  const exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
  clearTimeout(timer); clearInterval(heartbeat);
  if (timedOut) {
    await store.transition(task.task_id, 'failed', { reason: 'timeout', exit_code: exitCode });
    return { command, pid: child.pid, exitCode, timedOut };
  }
  if (exitCode !== 0) {
    await store.transition(task.task_id, 'failed', { reason: 'exit-nonzero', exit_code: exitCode });
    await store.event('exit', task.task_id, { pid: child.pid, exit_code: exitCode });
    return { command, pid: child.pid, exitCode };
  }
  const outcome = await gitOutcome(task, ctx, git);
  if (outcome.ok) await store.transition(task.task_id, 'succeeded', { commit: outcome.commit });
  else await store.transition(task.task_id, 'failed', { reason: outcome.reason });
  await store.event('exit', task.task_id, { pid: child.pid, exit_code: exitCode, ...outcome });
  return { command, pid: child.pid, exitCode, ...outcome };
}

export async function registerManual(driver, task, store) {
  await store.transition(task.task_id, 'dispatched', { driver: driver.name });
  await store.event('launch.manual', task.task_id, { driver: driver.name });
  return '任务书已登记待粘贴';
}

export async function attach(taskId, branch, store) {
  const task = await store.get(taskId);
  if (!task || task.status !== 'dispatched') throw new DispatchError(`task-id ${taskId} is not a manual dispatched task`);
  return store.annotate(taskId, { attached_branch: branch }, 'attach');
}

export async function heartbeatAgeMs(file, nowMs = Date.now()) {
  try { return nowMs - (await stat(file)).mtimeMs; } catch (error) { if (error.code === 'ENOENT') return Infinity; throw error; }
}
