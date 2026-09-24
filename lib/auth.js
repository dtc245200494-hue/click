import crypto from 'node:crypto';

export function parseCookies(raw = '') {
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function createAuthFromEnv(env = process.env) {
  const enabled = String(env.AUTH_ENABLED || 'false').toLowerCase() === 'true';
  const sessions = new Map();
  const users = enabled ? [
    { username: env.ADMIN_USER || '', password: env.ADMIN_PASSWORD || '', role: 'admin' },
    { username: env.GUEST_USER || '', password: env.GUEST_PASSWORD || '', role: 'guest' }
  ].filter(u => u.username && u.password) : [];

  if (enabled && !users.some(u => u.role === 'admin')) {
    throw new Error('AUTH_ENABLED=true requires ADMIN_USER and ADMIN_PASSWORD');
  }

  function login(username, password) {
    if (!enabled) return { token: 'local', user: { username: 'local', role: 'admin' } };
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) return null;
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username: user.username, role: user.role, createdAt: Date.now() });
    return { token, user: { username: user.username, role: user.role } };
  }

  function userFromCookie(rawCookie) {
    if (!enabled) return { username: 'local', role: 'admin' };
    const token = parseCookies(rawCookie).session_token;
    return token ? sessions.get(token) || null : null;
  }

  function logout(rawCookie) {
    const token = parseCookies(rawCookie).session_token;
    if (token) sessions.delete(token);
  }

  return { enabled, login, logout, userFromCookie };
}
