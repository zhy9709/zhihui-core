export class RouteError extends Error {
  constructor(message, code = 'ROUTE_ERROR') { super(message); this.code = code; }
}

function costTier(driver) { return typeof driver.cost === 'object' ? driver.cost.tier : driver.cost; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function driverState(state, name) { return state?.drivers?.[name] || {}; }

function healthReason(record) {
  const value = String(record.health || record.status || '').toUpperCase();
  return value === 'FAIL' || value === 'OFFLINE' ? `状态 ${value}，不可用` : null;
}

function successFactor(record) {
  const samples = Array.isArray(record.recent_results) ? record.recent_results : Array.isArray(record.last5) ? record.last5 : null;
  if (samples) {
    if (samples.length < 3) return { factor: 1, reason: `样本${samples.length}<3，成功率因子1.00` };
    const recent = samples.slice(-5); const wins = recent.filter((item) => item === true || item === 'success' || item === 'succeeded' || item === 'verified').length;
    const losses = recent.length - wins; const factor = Math.max(0.5, wins / recent.length);
    return { factor, reason: `近${recent.length}败${losses}→${factor.toFixed(2)}` };
  }
  const sampleSize = number(record.sample_size); const rate = number(record.success_rate);
  if (sampleSize != null && rate != null) {
    if (sampleSize < 3) return { factor: 1, reason: `样本${sampleSize}<3，成功率因子1.00` };
    const factor = Math.max(0.5, Math.min(1, rate)); return { factor, reason: `成功率${rate.toFixed(2)}→${factor.toFixed(2)}` };
  }
  return { factor: 1, reason: '成功率未知，按1.00' };
}

function isFreeTier(driver) { return ['free-tier', 'free'].includes(costTier(driver)); }

function costFactor(driver) {
  if (driver.kind === 'manual') return { factor: 0.95, reason: 'manual，成本权重0.95' };
  if (costTier(driver) === 'paid-fixed') return { factor: 0.9, reason: 'paid-fixed，成本权重0.90' };
  return { factor: 1, reason: 'free-tier，成本权重1.00' };
}

function gate(driver, payload, state) {
  const record = driverState(state, driver.name); const required = payload.caps_required || [];
  const missing = required.filter((cap) => !driver.caps.includes(cap));
  if (missing.length) return `能力缺少: ${missing.join(', ')}`;
  const unhealthy = healthReason(record); if (unhealthy) return unhealthy;
  const quota = number(record.quota?.value);
  if (isFreeTier(driver) && quota != null && quota < 0.2) return `水位${quota.toFixed(2)}<0.20，出队`;
  return null;
}

export function routeTask(task, fleet, state = {}, { to = null } = {}) {
  const payload = task.payload || task;
  const difficulty = number(payload.difficulty ?? 5);
  if (difficulty == null || difficulty < 1 || difficulty > 10) throw new RouteError('task payload difficulty must be 1-10');
  if (payload.caps_required != null && !Array.isArray(payload.caps_required)) throw new RouteError('task payload caps_required must be an array');
  const eligible = []; const excluded = [];
  fleet.drivers.forEach((driver, index) => {
    const blocked = gate(driver, payload, state);
    if (blocked) { excluded.push({ driver: driver.name, reason: blocked }); return; }
    const record = driverState(state, driver.name); const cost = costFactor(driver); const success = successFactor(record); let bonus = 0; let difficultyReason = null;
    if (difficulty >= 8 && driver.model_tier === 'high') { bonus = 0.2; difficultyReason = `难度${difficulty}，high 模型+0.20`; }
    if (difficulty <= 3 && driver.model_tier === 'low') { bonus = 0.1; difficultyReason = `难度${difficulty}，low 模型+0.10`; }
    const capability = (payload.caps_required || []).length ? `能力满足: ${payload.caps_required.join(', ')}` : '无能力硬门槛';
    const quota = number(record.quota?.value); const quotaReason = quota == null ? '额度未知，未作水位扣减' : `水位${quota.toFixed(2)}`;
    const reasons = [capability, `${quotaReason}；${cost.reason}`, success.reason]; if (difficultyReason) reasons[0] = difficultyReason;
    eligible.push({ driver: driver.name, score: Math.round((cost.factor * success.factor + bonus) * 10_000) / 10_000, reasons: reasons.slice(0, 3), _index: index });
  });
  if (to) {
    const selected = eligible.find((item) => item.driver === to);
    if (!selected) { const reason = excluded.find((item) => item.driver === to)?.reason || `driver ${to} not found`; throw new RouteError(`--to ${to} 被拒绝: ${reason}`, 'ROUTE_INELIGIBLE'); }
    return { suggestions: [{ ...selected, reasons: [...selected.reasons.slice(0, 2), '--to 指定且已通过硬门槛'] }], excluded, forced: true };
  }
  eligible.sort((a, b) => b.score - a.score || a._index - b._index || a.driver.localeCompare(b.driver));
  if (!eligible.length) throw new RouteError(`无可用 driver：${excluded.map((item) => `${item.driver}(${item.reason})`).join('；')}`, 'ROUTE_EMPTY');
  return { suggestions: eligible.map(({ _index, ...item }) => item), excluded, forced: false };
}
