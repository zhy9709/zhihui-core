import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDriver, collectStatus, commandForPlatform, doctor, validateFleet } from '../src/fleet.mjs';

const valid = (overrides = {}) => ({
  name: 'fake', kind: 'headless', command: 'fake-cli', caps: ['node'], cost: 'free', quota_probe: null,
  host: 'test-host', platform: 'linux', timeout_min: 10, ...overrides
});
const fleet = (driver = valid()) => ({ drivers: [driver] });

test('validate accepts a complete driver schema', () => assert.equal(validateFleet(fleet(), 'fake.json').drivers.length, 1));

test('validate reports missing caps and source file', () => {
  const driver = valid(); delete driver.caps;
  assert.throws(() => validateFleet(fleet(driver), 'fake.json'), /fake\.json: .*caps is required/);
});

test('validate reports an unknown kind', () => assert.throws(() => validateFleet(fleet(valid({ kind: 'magic' })), 'fake.json'), /kind must be headless, manual, or acp/));

test('validate reports duplicate names', () => assert.throws(() => validateFleet({ drivers: [valid(), valid()] }, 'fake.json'), /duplicates fake/));

test('add rejects a duplicate driver without changing the registry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zh-fleet-'));
  const file = join(directory, 'fleet.json');
  await addDriver(file, valid());
  await assert.rejects(addDriver(file, valid()), /already exists/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).drivers.length, 1);
});

test('doctor returns PASS when all mocked probes pass', async () => {
  const result = await doctor(fleet(valid({ login_probe: 'login', quota_probe: 'quota' })), { probe: async () => ({ ok: true }) });
  assert.equal(result.level, 'PASS'); assert.equal(result.exitCode, 0);
});

test('doctor returns WARN for optional missing login and quota probes', async () => {
  const result = await doctor(fleet(), { probe: async () => ({ ok: true }) });
  assert.equal(result.level, 'WARN'); assert.equal(result.exitCode, 1);
});

test('doctor returns FAIL when executable is absent', async () => {
  const result = await doctor(fleet(), { probe: async () => ({ ok: false }) });
  assert.equal(result.level, 'FAIL'); assert.equal(result.exitCode, 2);
});

test('Windows doctor probe uses where, without a Windows host', () => {
  assert.deepEqual(commandForPlatform(valid({ platform: 'win', command: 'thing --flag' })), { command: 'where', args: ['thing'] });
});

test('linux and mac doctor probes use command -v', () => {
  assert.deepEqual(commandForPlatform(valid({ platform: 'linux' })), { command: 'command', args: ['-v', 'fake-cli'] });
  assert.deepEqual(commandForPlatform(valid({ platform: 'mac' })), { command: 'command', args: ['-v', 'fake-cli'] });
});

test('status records a finite fact for paid fixed plans', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'zh-state-'));
  const result = await collectStatus(fleet(valid({ cost: 'paid-fixed', quota_probe: 'quota', rate_limit: '5h window' })), {
    dataDir, probe: async () => ({ ok: true }), now: () => '2026-01-01T00:00:00.000Z',
    quotaProbe: async () => ({ value: 'unlimited', source: 'bad-probe' })
  });
  assert.deepEqual(result.state.drivers.fake.quota, { value: '5h window', source: 'fixed_plan', measured_at: '2026-01-01T00:00:00.000Z', confidence: 'declared' });
});
