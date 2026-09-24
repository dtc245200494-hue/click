import { runSchedulerTests } from './scheduler.test.js';
import { runPoolTests } from './pool.test.js';
import { runRequestClientTests } from './requestClient.test.js';
import { runTargetPolicyTests } from './targetPolicy.test.js';
import { runGlobalCapacityTests } from './globalCapacity.test.js';
import { runStateStoreTests } from './stateStore.test.js';
import { runAuthTests } from './auth.test.js';

const tests = [
  ['scheduler-smart-even-custom', runSchedulerTests],
  ['worker-pool', runPoolTests],
  ['request-client', runRequestClientTests],
  ['target-policy', runTargetPolicyTests],
  ['global-capacity', runGlobalCapacityTests],
  ['state-persistence', runStateStoreTests],
  ['auth-roles', runAuthTests]
];

let passed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL ${name}:`, err);
    process.exitCode = 1;
  }
}
console.log(`${passed}/${tests.length} test groups passed`);
