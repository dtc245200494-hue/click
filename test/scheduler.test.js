import assert from 'node:assert/strict';
import { buildDistribution, generateSchedule } from '../lib/scheduler.js';

export function runSchedulerTests() {
  const offset = -420;
  const start = Date.parse('2026-09-24T00:00:00Z');
  const end = Date.parse('2026-09-24T06:00:00Z');

  const even = buildDistribution({ startTime:start, endTime:end, targetRequests:750, mode:'even', timezoneOffsetMinutes:offset });
  assert.deepEqual(even.slices.map(x => x.quota), [125,125,125,125,125,125]);
  const evenSchedule = generateSchedule({ startTime:start, endTime:end, targetRequests:750, mode:'even', timezoneOffsetMinutes:offset });
  assert.equal(evenSchedule.length, 750);
  assert.ok(evenSchedule.every(t => t >= start && t < end));

  const smart = buildDistribution({ startTime:start, endTime:end, targetRequests:750, mode:'smart', timezoneOffsetMinutes:offset });
  assert.deepEqual(smart.slices.map(x=>x.hour), [7,8,9,10,11,12]);
  assert.deepEqual(smart.slices.map(x=>x.quota), [86,114,152,161,142,95]);
  assert.equal(smart.slices.reduce((s,x)=>s+x.quota,0), 750);

  const custom = buildDistribution({
    startTime:start, endTime:end, targetRequests:750, mode:'custom', timezoneOffsetMinutes:offset,
    customBlocks:{ early_morning:'low', morning:'high', noon:'medium' }
  });
  assert.equal(custom.slices.reduce((s,x)=>s+x.quota,0), 750);
  const byHour = new Map(custom.slices.map(x => [x.hour, x.quota]));
  assert.ok(byHour.get(9) > byHour.get(7));
  assert.ok(byHour.get(10) > byHour.get(8));
  const customSchedule = generateSchedule({ startTime:start, endTime:end, targetRequests:750, mode:'custom', timezoneOffsetMinutes:offset, customBlocks:{early_morning:'low',morning:'high',noon:'medium'} });
  assert.equal(customSchedule.length, 750);
  assert.ok(customSchedule.every(t => t >= start && t < end));
}
