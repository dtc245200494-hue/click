import http from 'node:http';
import https from 'node:https';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });

export function requestOnce(rawUrl, { timeoutMs = 15000, method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const url = new URL(rawUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const agent = url.protocol === 'https:' ? httpsAgent : httpAgent;

    const req = lib.request(url, {
      method,
      agent,
      headers: {
        'user-agent': 'scheduled-loadtest-dashboard/0.1',
        'accept': '*/*',
        'connection': 'keep-alive'
      }
    }, (res) => {
      // Drain response without storing body to keep RAM use low.
      res.resume();
      res.on('end', () => {
        const latencyMs = Math.max(0, performance.now() - started);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          statusCode: res.statusCode,
          latencyMs
        });
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      resolve({ ok: false, statusCode: null, latencyMs: Math.max(0, performance.now() - started), error: error.message });
    });
    req.end();
  });
}
