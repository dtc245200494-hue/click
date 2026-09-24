import assert from 'node:assert/strict';
import http from 'node:http';
import { requestOnce } from '../lib/requestClient.js';

export async function runRequestClientTests() {
  const server = http.createServer((req,res) => {
    if (req.url === '/bad') { res.statusCode = 503; res.end('bad'); return; }
    res.statusCode = 204; res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const ok = await requestOnce(`http://127.0.0.1:${port}/ok`, { timeoutMs:1000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.statusCode, 204);
    const bad = await requestOnce(`http://127.0.0.1:${port}/bad`, { timeoutMs:1000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.statusCode, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
