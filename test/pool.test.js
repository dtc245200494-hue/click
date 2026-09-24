import assert from 'node:assert/strict';
import { RequestPool } from '../lib/requestPool.js';

export async function runPoolTests() {
  const pool = new RequestPool(3);
  let active = 0;
  let maxSeen = 0;
  let completed = 0;
  for (let i = 0; i < 20; i++) {
    pool.enqueue(async () => {
      active += 1;
      maxSeen = Math.max(maxSeen, active);
      await new Promise(r => setTimeout(r, 5));
      active -= 1;
      completed += 1;
    });
  }
  while (completed < 20) await new Promise(r => setTimeout(r, 5));
  assert.equal(completed, 20);
  assert.ok(maxSeen <= 3, `max concurrency ${maxSeen} exceeded cap`);
}
