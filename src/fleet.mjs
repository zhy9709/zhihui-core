import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, atomicWriteJson, stateFile } from './state.mjs';

const execFileAsync = promisify(execFile);
const KINDS = new Set(['headless', 'manual', 'acp']);
const PLATFORMS = new Set(['win', 'linux', 'mac']);

export class FleetValidationError extends Error {
  constructor(file, issues) {
    super(`${file}: ${issues.join('; ')}`);
    this.name = 'FleetValidationError';
    this.issues = issues;
  }
}

export async function loadFleet(file) {
  return readJson(file, { drivers: [] });
}

export function validateFleet(fleet, file = 'fleet.json') {
  const issues = [];
  if (!fleet || typeof fleet !== 'object' || Array.isArray(fleet)) {
    throw new FleetValidationError(file, ['root must be an object']);
  }
  if (!Array.isArray(fleet.drivers)) issues.push('drivers must be an array');
  if ('workspaces_root' in fleet && (typeof fleet.workspaces_root !== 'string' || !fleet.workspaces_root.trim())) issues.push('workspaces_root must be a non-empty string');
  if ('max_worktrees' in fleet && (!Number.isInteger(fleet.max_worktrees) || fleet.max_worktrees < 1)) issues.push('max_worktrees must be a positive integer');
  const names = new Set();
  for (const [index, driver] of (fleet.drivers || []).entries()) {
    const at = `drivers[${index}]`;
    if (!driver || typeof driver !== 'object' || Array.isArray(driver)) { issues.push(`${at} must be an object`); continue; }
    for (const field of ['name', 'kind', 'caps', 'cost', 'quota_probe', 'host', 'platform', 'timeout_min']) {
      if (!(field in driver)) issues.push(`${at}.${field} is required`);
    }
    if (typeof driver.name !== 'string' || !driver.name.trim()) issues.push(`${at}.name must be a non-empty string`);
    if (names.has(driver.name)) issues.push(`${at}.name duplicates ${driver.name}`);
    names.add(driver.name);
    if (!KINDS.has(driver.kind)) issues.push(`${at}.kind must be headless, manual, or acp`);
    if (!Array.isArray(driver.caps) || driver.caps.some((cap) => typeof cap !== 'string')) issues.push(`${at}.caps must be a string array`);
    if (typeof driver.cost !== 'string' && (!driver.cost || typeof driver.cost !== 'object')) issues.push(`${at}.cost must be a string or object`);
    if (driver.quota_probe !== null && typeof driver.quota_probe !== 'string' && typeof driver.quota_probe !== 'object') issues.push(`${at}.quota_probe must be null, string, or object`);
    if (typeof driver.host !== 'string' || !driver.host.trim()) issues.push(`${at}.host must be a host alias`);
    if (!PLATFORMS.has(driver.platform)) issues.push(`${at}.platform must be win, linux, or mac`);
    if (typeof driver.timeout_min !== 'number' || driver.timeout_min <= 0) issues.push(`${at}.timeout_min must be a positive number`);
  }
  if (issues.length) throw new FleetValidationError(file, issues);
  return fleet;
}

export async function addDriver(file, driver) {
  const fleet = await loadFleet(file);
  fleet.drivers ||= [];
  if (fleet.drivers.some((item) => item.name === driver.name)) {
    throw new FleetValidationError(file, [`driver name ${driver.name} already exists`]);
  }
  fleet.drivers.push(driver);
  validateFleet(fleet, file);
  await atomicWriteJson(file, fleet);
  return driver;
}

export function commandForPlatform(driver) {
  const executable = String(driver.command || driver.name).trim().split(/\s+/)[0];
  return driver.platform === 'win'
    ? { command: 'where', args: [executable] }
    : { command: 'command', args: ['-v', executable] };
}

export async function defaultProbe(spec) {
  try {
    if (spec.command === 'command') await execFileAsync('/bin/sh', ['-lc', 'command -v "$1"', 'sh', spec.args[1]]);
    else await execFileAsync(spec.command, spec.args);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function status(level, message) { return { level, message }; }

export async function doctorDriver(driver, { probe = defaultProbe } = {}) {
  const checks = [];
  if (!driver.command && driver.kind !== 'headless') checks.push(status('WARN', 'no executable command configured'));
  else {
    const result = await probe({ ...commandForPlatform(driver), driver });
    checks.push(status(result.ok ? 'PASS' : 'FAIL', result.ok ? 'executable found' : 'executable not found'));
  }
  if (driver.login_probe == null) checks.push(status('WARN', 'login probe not configured'));
  else {
    const result = await probe({ type: 'login', command: driver.login_probe, driver });
    checks.push(status(result.ok ? 'PASS' : 'FAIL', result.ok ? 'login verified' : 'login unavailable'));
  }
  if (driver.quota_probe == null) checks.push(status('WARN', 'quota probe not configured'));
  else {
    const result = await probe({ type: 'quota', command: driver.quota_probe, driver });
    checks.push(status(result.ok ? 'PASS' : 'WARN', result.ok ? 'quota probe available' : 'quota probe unavailable'));
  }
  const level = checks.some((item) => item.level === 'FAIL') ? 'FAIL' : checks.some((item) => item.level === 'WARN') ? 'WARN' : 'PASS';
  return { name: driver.name, level, checks };
}

export async function doctor(fleet, options = {}) {
  validateFleet(fleet, options.file || 'fleet.json');
  const drivers = await Promise.all(fleet.drivers.map((driver) => doctorDriver(driver, options)));
  const level = drivers.some((item) => item.level === 'FAIL') ? 'FAIL' : drivers.some((item) => item.level === 'WARN') ? 'WARN' : 'PASS';
  return { level, exitCode: level === 'PASS' ? 0 : level === 'WARN' ? 1 : 2, drivers };
}

function isFixedPlan(cost) {
  return cost === 'paid-fixed' || (cost && typeof cost === 'object' && cost.tier === 'paid-fixed');
}

export async function collectStatus(fleet, { dataDir = 'state', now = () => new Date().toISOString(), quotaProbe = async () => null, probe } = {}) {
  const health = await doctor(fleet, { probe });
  const current = await readJson(stateFile(dataDir), { drivers: {} });
  current.drivers ||= {};
  for (const driver of fleet.drivers) {
    let quota = driver.quota_probe == null ? null : await quotaProbe(driver);
    if (isFixedPlan(driver.cost) && (quota?.value === Infinity || quota?.value === 'unlimited')) {
      quota = { value: driver.rate_limit || 'rate-limit-unknown', source: 'fixed_plan', confidence: 'declared' };
    }
    current.drivers[driver.name] = {
      ...(current.drivers[driver.name] || {}),
      health: health.drivers.find((item) => item.name === driver.name).level,
      quota: quota ? { value: quota.value, source: quota.source || 'probe', measured_at: quota.measured_at || now(), confidence: quota.confidence || 'measured' } : null,
      updated_at: now()
    };
  }
  await atomicWriteJson(stateFile(dataDir), current);
  return { health, state: current };
}
