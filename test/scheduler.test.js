import assert from 'node:assert/strict';
import { buildDistribution, generateSchedule } from '../lib/scheduler.js';

export function runSchedulerTests() {
  const offset = -420; // Vietnam: UTC+7 in JS getTimezoneOffset convention.
  const start = Date.parse('2026-09-24T00:00:00Z'); // 07:00 VN
  const end = Date.parse('2026-09-24T06:00:00Z');   // 13:00 VN

  const even = buildDistribution({ startTime:start, endTime:end, targetRequests:750, mode:'even', timezoneOffsetMinutes:offset });
  assert.equal(even.slices.length, 6);
  assert.deepEqual(even.slices.map(x => x.quota), [125,125,125,125,125,125]);
  const evenSchedule = generateSchedule({ startTime:start, endTime:end, targetRequests:750, mode:'even', timezoneOffsetMinutes:offset });
  assert.equal(evenSchedule.length, 750);
  assert.ok(evenSchedule.every(t => t >= start && t < end));

  const smart = buildDistribution({ startTime:start, endTime:end, targetRequests:750, mode:'smart', timezoneOffsetMinutes:offset });
  assert.equal(smart.slices.reduce((s,x)=>s+x.quota,0), 750);
  assert.deepEqual(smart.slices.map(x=>x.hour), [7,8,9,10,11,12]);
  assert.deepEqual(smart.slices.map(x=>x.quota), [86,114,152,161,142,95]);
  const smartSchedule = generateSchedule({ startTime:start, endTime:end, targetRequests:750, mode:'smart', timezoneOffsetMinutes:offset });
  assert.equal(smartSchedule.length, 750);
  assert.ok(smartSchedule.every(t => t >= start && t < end));
}
