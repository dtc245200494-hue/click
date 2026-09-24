import assert from 'node:assert/strict';
import { createAuthFromEnv } from '../lib/auth.js';

export function runAuthTests() {
  const local = createAuthFromEnv({ AUTH_ENABLED:'false' });
  assert.equal(local.userFromCookie('')?.role, 'admin');

  const auth = createAuthFromEnv({
    AUTH_ENABLED:'true', ADMIN_USER:'root', ADMIN_PASSWORD:'pw-a',
    GUEST_USER:'viewer', GUEST_PASSWORD:'pw-b'
  });
  assert.equal(auth.login('root','bad'), null);
  const admin = auth.login('root','pw-a');
  assert.equal(admin.user.role, 'admin');
  assert.equal(auth.userFromCookie(`session_token=${admin.token}`).role, 'admin');
  const guest = auth.login('viewer','pw-b');
  assert.equal(guest.user.role, 'guest');
  auth.logout(`session_token=${guest.token}`);
  assert.equal(auth.userFromCookie(`session_token=${guest.token}`), null);
}
