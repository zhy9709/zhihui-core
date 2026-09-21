import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

function tail(value, lines = 50) { return String(value || '').split(/\r?\n/).slice(-lines).join('\n'); }

export function safePath(worktree, path) {
  const root = resolve(worktree); const candidate = resolve(root, path);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error(`assertion path escapes worktree: ${path}`);
  return candidate;
}

export async function spawnCheck(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolveResult) => {
    let stdout = ''; let stderr = ''; let timedOut = false;
    let child;
    try { child = spawn(cmd, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolveResult({ exit: null, stdout, stderr: error.message, errorCode: error.code }); return; }
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolveResult({ exit: null, stdout, stderr: `${stderr}${error.message}`, errorCode: error.code, timedOut }); });
    child.once('close', (exit) => { clearTimeout(timer); resolveResult({ exit, stdout, stderr, timedOut }); });
  });
}

async function runAssertion(assertion, worktree) {
  const file = safePath(worktree, assertion.path);
  try {
    const info = await stat(file);
    if (assertion.expect === 'exists') return { ok: true, detail: 'exists' };
    if (assertion.expect === 'absent') return { ok: false, detail: 'exists but expected absent' };
    if (assertion.expect === 'file-contains') {
      if (!info.isFile()) return { ok: false, detail: 'not a regular file' };
      const content = await readFile(file, 'utf8');
      return content.includes(assertion.substring || '') ? { ok: true, detail: 'substring found' } : { ok: false, detail: `missing substring: ${assertion.substring || ''}` };
    }
    return { ok: false, detail: `unknown assertion expect: ${assertion.expect}` };
  } catch (error) {
    if (error.code === 'ENOENT' && assertion.expect === 'absent') return { ok: true, detail: 'absent' };
    return { ok: false, detail: error.code === 'ENOENT' ? 'missing' : error.message };
  }
}

export async function runAcceptance(task, { worktree = task.worktree, runCheck = spawnCheck } = {}) {
  const acceptance = task.payload?.acceptance;
  if (!acceptance || !Array.isArray(acceptance.checks) || !Array.isArray(acceptance.assertions)) throw new Error('task payload requires acceptance.checks and acceptance.assertions');
  if (!worktree) throw new Error('acceptance requires task worktree');
  const timeoutMs = (acceptance.timeout_sec || 300) * 1000;
  const results = [];
  for (const check of acceptance.checks) {
    const outcome = await runCheck(check.cmd, check.args || [], { cwd: worktree, timeoutMs });
    const expected = check.expect_exit ?? 0;
    results.push({ name: check.name, ok: !outcome.timedOut && outcome.exit === expected, detail: outcome.timedOut ? 'timeout' : `exit ${outcome.exit} (expect ${expected})`, ...outcome, stdout: tail(outcome.stdout), stderr: tail(outcome.stderr) });
  }
  for (const assertion of acceptance.assertions) {
    const outcome = await runAssertion(assertion, worktree);
    results.push({ name: assertion.name, ok: outcome.ok, detail: outcome.detail, type: 'assertion' });
  }
  return { pass: results.every((item) => item.ok), results };
}
