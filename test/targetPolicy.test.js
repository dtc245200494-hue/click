import assert from 'node:assert/strict';
import { validateTargetUrl } from '../lib/targetPolicy.js';

export function runTargetPolicyTests() {
  assert.equal(validateTargetUrl('http://127.0.0.1:3000/test').ok, true);
  assert.equal(validateTargetUrl('https://staging.example.com/test', 'staging.example.com').ok, true);
  assert.equal(validateTargetUrl('https://example.org/test', 'staging.example.com').ok, false);
  assert.equal(validateTargetUrl('ftp://staging.example.com/test', 'staging.example.com').ok, false);
}
