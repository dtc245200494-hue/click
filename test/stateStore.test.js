import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../lib/stateStore.js';

export function runStateStoreTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-state-'));
  const file = path.join(dir, 'campaigns.json');
  const store = new StateStore(file);
  const campaigns = [{id:'a',scheduleIdx:42,attempted:50,successfulSlots:[1,2],retryQueue:[{slotId:3,attempt:1,dueAt:123}]}];
  store.save(campaigns);
  assert.deepEqual(store.load(), campaigns);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.rmSync(dir, { recursive:true, force:true });
}
