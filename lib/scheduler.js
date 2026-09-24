const SMART_HOURLY_WEIGHTS = {
  0: 0.25, 1: 0.15, 2: 0.10, 3: 0.10, 4: 0.15, 5: 0.30,
  6: 0.60, 7: 0.90, 8: 1.20,
  9: 1.60, 10: 1.70, 11: 1.50,
  12: 1.00, 13: 1.10,
  14: 1.60, 15: 1.80, 16: 1.70, 17: 1.50,
  18: 1.40, 19: 1.60, 20: 1.70, 21: 1.50,
  22: 1.00, 23: 0.60
};

const CUSTOM_LEVEL_WEIGHTS = { low: 0.30, medium: 1.00, high: 1.80 };
const CUSTOM_BLOCKS = [
  ['night', 0, 6, 'low'],
  ['early_morning', 6, 9, 'medium'],
  ['morning', 9, 12, 'high'],
  ['noon', 12, 14, 'medium'],
  ['afternoon', 14, 18, 'high'],
  ['evening', 18, 22, 'high'],
  ['late_night', 22, 24, 'medium']
];

function customWeightMap(customBlocks = {}) {
  const weights = {};
  for (const [name, from, to, fallback] of CUSTOM_BLOCKS) {
    const level = CUSTOM_LEVEL_WEIGHTS[customBlocks?.[name]] ? customBlocks[name] : fallback;
    for (let hour = from; hour < to; hour++) weights[hour] = CUSTOM_LEVEL_WEIGHTS[level];
  }
  return weights;
}

function toOffsetDate(ms, timezoneOffsetMinutes = null) {
  if (!Number.isFinite(Number(timezoneOffsetMinutes))) return new Date(ms);
  return new Date(ms - Number(timezoneOffsetMinutes) * 60000);
}

function hourForTimezone(ms, timezoneOffsetMinutes = null) {
  const d = toOffsetDate(ms, timezoneOffsetMinutes);
  return Number.isFinite(Number(timezoneOffsetMinutes)) ? d.getUTCHours() : d.getHours();
}

function nextHour(ms, timezoneOffsetMinutes = null) {
  if (!Number.isFinite(Number(timezoneOffsetMinutes))) {
    const d = new Date(ms);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  const offset = Number(timezoneOffsetMinutes);
  const local = new Date(ms - offset * 60000);
  const nextLocalUtc = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    local.getUTCHours() + 1, 0, 0, 0
  );
  return nextLocalUtc + offset * 60000;
}

export function buildDistribution({ startTime, endTime, targetRequests, mode = 'smart', customBlocks = null, timezoneOffsetMinutes = null }) {
  const startMs = Number(startTime);
  const endMs = Number(endTime);
  const target = Number.parseInt(targetRequests, 10);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !Number.isInteger(target) || target <= 0) {
    return { valid: false, slices: [], targetRequests: 0, durationMs: 0 };
  }

  const normalizedMode = ['smart', 'even', 'custom'].includes(mode) ? mode : 'smart';
  const customWeights = normalizedMode === 'custom' ? customWeightMap(customBlocks) : null;
  const raw = [];
  let cur = startMs;
  while (cur < endMs) {
    const end = Math.min(endMs, nextHour(cur, timezoneOffsetMinutes));
    const durationMs = end - cur;
    const hour = hourForTimezone(cur, timezoneOffsetMinutes);
    const baseWeight = normalizedMode === 'even' ? 1 : normalizedMode === 'custom' ? customWeights[hour] : (SMART_HOURLY_WEIGHTS[hour] ?? 1);
    raw.push({ start: cur, end, hour, durationMs, weight: baseWeight * (durationMs / 3600000) });
    cur = end;
  }

  const totalWeight = raw.reduce((s, x) => s + x.weight, 0);
  let allocated = 0;
  const slices = raw.map((slice, index) => {
    const exact = target * slice.weight / totalWeight;
    const quota = Math.floor(exact);
    allocated += quota;
    return { ...slice, index, quota, remainder: exact - quota };
  });

  let remainder = target - allocated;
  for (const item of [...slices].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remainder <= 0) break;
    slices[item.index].quota += 1;
    remainder -= 1;
  }

  return {
    valid: true, startMs, endMs, durationMs: endMs - startMs, targetRequests: target,
    mode: normalizedMode, customBlocks, timezoneOffsetMinutes, slices
  };
}

export function generateSchedule(options) {
  const dist = buildDistribution(options);
  if (!dist.valid) return [];
  const timestamps = [];
  for (const slice of dist.slices) {
    if (slice.quota <= 0) continue;
    const bucket = slice.durationMs / slice.quota;
    for (let i = 0; i < slice.quota; i++) {
      timestamps.push(Math.floor(slice.start + (i + 0.5) * bucket));
    }
  }
  return timestamps.sort((a, b) => a - b);
}

export { SMART_HOURLY_WEIGHTS, CUSTOM_LEVEL_WEIGHTS };
