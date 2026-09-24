import net from 'node:net';

function parseAllowlist(value = process.env.ALLOWED_TARGET_HOSTS || '') {
  return new Set(value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
}

function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const ipType = net.isIP(h);
  if (ipType === 4) return h.startsWith('127.');
  return false;
}

export function validateTargetUrl(rawUrl, allowlistValue) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL không hợp lệ.' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, reason: 'Chỉ hỗ trợ HTTP/HTTPS.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Không cho phép credential trong URL.' };
  }
  if (isLoopbackHost(url.hostname)) return { ok: true, url };

  const allowed = parseAllowlist(allowlistValue);
  if (!allowed.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: `Host ${url.hostname} chưa có trong ALLOWED_TARGET_HOSTS.` };
  }
  return { ok: true, url };
}
