import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAcceptance } from './gates.mjs';
import { atomicWriteFile } from './state.mjs';

const execFileAsync = promisify(execFile);
async function defaultGit(args, options = {}) { return (await execFileAsync('git', args, options)).stdout.trim(); }
function tail(value) { return String(value || '').split(/\r?\n/).slice(-50).join('\n'); }

function isCollectable(task) { return task.status === 'succeeded' || (task.status === 'dispatched' && task.attached_branch); }
function failClass(results) {
  const failed = results.filter((item) => !item.ok && item.type !== 'assertion');
  if (failed.length && failed.every((item) => item.timedOut)) return 'env';
  if (failed.some((item) => item.errorCode === 'ENOENT')) return 'auth-env';
  return 'assertion';
}

async function nextReworkFile(store, taskId) {
  const directory = join(store.dataDir, 'rework'); let files = [];
  try { files = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const numbers = files.map((file) => Number(file.match(new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.md$`))?.[1] || 0));
  return join(directory, `${taskId}-${Math.max(0, ...numbers) + 1}.md`);
}

async function writeRework(store, task, acceptance, results) {
  const file = await nextReworkFile(store, task.task_id);
  const failures = results.filter((item) => !item.ok).map((item) => `### ${item.name}\n- detail: ${item.detail}\n- exit: ${item.exit ?? 'n/a'}\n- stdout:\n\`\`\`\n${tail(item.stdout)}\n\`\`\`\n- stderr:\n\`\`\`\n${tail(item.stderr)}\n\`\`\``).join('\n\n');
  const content = `# 修复工单：${task.task_id}\n\n## 1. 原任务与验收配置\n\n${task.payload.brief || '(无 brief)'}\n\n\`\`\`json\n${JSON.stringify(acceptance, null, 2)}\n\`\`\`\n\n## 2. 实测问题\n\n${failures || '(无失败细节)'}\n\n## 3. 期望行为与复验判据\n\n修复后重新执行以上 acceptance 配置；全部 checks 与 assertions 均须通过。\n`;
  await atomicWriteFile(file, content);
  return file;
}

export async function collect(taskId, { store, git = defaultGit, gateContext = {}, now = () => new Date() } = {}) {
  const task = await store.get(taskId);
  if (!task) throw new Error(`task-id ${taskId} does not exist`);
  if (!isCollectable(task)) { const error = new Error(`task-id ${taskId} must be succeeded or attached dispatched before collect`); error.code = 'COLLECT_PRECONDITION'; throw error; }
  const acceptance = task.payload.acceptance;
  const result = await runAcceptance(task, { worktree: task.worktree || task.payload.worktree, ...gateContext });
  await store.event('collect.gates', taskId, { pass: result.pass, results: result.results.map(({ name, ok, detail }) => ({ name, ok, detail })) });
  if (!result.pass) {
    const reworkFile = await writeRework(store, task, acceptance, result.results);
    const classification = failClass(result.results);
    await store.transition(taskId, 'rejected', { fail_class: classification, rework_file: reworkFile, acceptance_results: result.results });
    return { pass: false, results: result.results, fail_class: classification, rework_file: reworkFile };
  }
  const mergeRef = acceptance.merge_ref || 'main'; const source = task.attached_branch || `fleet/${taskId}`; const cwd = task.payload.repo_path;
  await git(['checkout', mergeRef], { cwd }); await git(['merge', '--no-ff', source], { cwd }); await git(['tag', `verified/${taskId}`], { cwd });
  const retainedUntil = new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString();
  await store.transition(taskId, 'verified', { merge_ref: mergeRef, verified_tag: `verified/${taskId}`, worktree_retained_until: retainedUntil, acceptance_results: result.results });
  await store.event('collect.verified', taskId, { merge_ref: mergeRef, source, tag: `verified/${taskId}` });
  return { pass: true, results: result.results, tag: `verified/${taskId}`, retained_until: retainedUntil };
}

export async function prune(store, { git = defaultGit, nowMs = Date.now() } = {}) {
  const removed = [];
  for (const task of await store.list()) {
    if (task?.status !== 'verified' || !task.worktree || Date.parse(task.worktree_retained_until || '') > nowMs) continue;
    await git(['worktree', 'remove', '--force', task.worktree], { cwd: task.payload.repo_path });
    await store.annotate(task.task_id, { worktree_pruned_at: new Date(nowMs).toISOString() }, 'worktree.pruned'); removed.push(task.task_id);
  }
  return removed;
}

export async function history(store, taskId) {
  let content = ''; try { content = await readFile(store.eventsFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.task_id === taskId);
}
