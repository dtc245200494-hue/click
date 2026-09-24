import assert from 'node:assert/strict';
import { countActiveWorkers, getGlobalFreeSlots } from '../lib/capacity.js';

export function runGlobalCapacityTests() {
  const campaigns = [
    { pool: { active: 7 } },
    { pool: { active: 6 } },
    { pool: { active: 2 } }
  ];
  assert.equal(countActiveWorkers(campaigns), 15);
  assert.equal(getGlobalFreeSlots(campaigns, 20), 5);
  assert.equal(getGlobalFreeSlots(campaigns, 10), 0);
  assert.equal(getGlobalFreeSlots([], 20), 20);
}
