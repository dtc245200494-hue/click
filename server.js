import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildDistribution, generateSchedule } from './lib/scheduler.js';
import { validateTargetUrl } from './lib/targetPolicy.js';
import { requestOnce } from './lib/requestClient.js';
import { RequestPool } from './lib/requestPool.js';
import { countActiveWorkers, getGlobalFreeSlots } from './lib/capacity.js';
import { StateStore } from './lib/stateStore.js';
import { createAuthFromEnv } from './lib/auth.js';
import { sendTelegramSummary } from './lib/telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3005);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY || 20));
const MAX_CAMPAIGN_REQUESTS = Math.max(1, Number(process.env.MAX_CAMPAIGN_REQUESTS || 100000));
const MIN_CAMPAIGN_SECONDS = Math.max(1, Number(process.env.MIN_CAMPAIGN_SECONDS || 60));
const REQUEST_TIMEOUT_MS = Math.max(250, Number(process.env.REQUEST_TIMEOUT_MS || 15000));
const MAX_RETRIES_PER_SLOT = Math.max(0, Math.min(5, Number(process.env.MAX_RETRIES_PER_SLOT || 2)));
const RETRY_BACKOFF_MS = Math.max(250, Math.min(30000, Number(process.env.RETRY_BACKOFF_MS || 2000)));
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'data', 'campaigns.json');

const auth = createAuthFromEnv(process.env);
const store = new StateStore(STATE_FILE);
const campaigns = new Map();
let persistTimer = null;

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]);
}

function publicCampaign(c) {
  return {
    id: c.id,
    name: c.name,
    targetUrl: c.targetUrl,
    startTime: c.startTime,
    endTime: c.endTime,
    targetRequests: c.targetRequests,
    mode: c.mode,
    customBlocks: c.customBlocks,
    concurrency: c.concurrency,
    status: c.status,
    scheduled: c.schedule.length,
    dispatched: c.scheduleIdx,
    attempted: c.attempted,
    success: c.successfulSlots.size,
    failedAttempts: c.failedAttempts,
    exhaustedSlots: c.exhaustedSlots.size,
    retryPending: c.retryQueue.length,
    activeWorkers: c.pool.active,
    globalActiveWorkers: countActiveWorkers(campaigns.values()),
    globalMaxConcurrency: MAX_CONCURRENCY,
    p50ApproxMs: percentile(c.latencies, 0.50),
    p95ApproxMs: percentile(c.latencies, 0.95)
  };
}

function serializeCampaign(c) {
  return {
    id: c.id,
    name: c.name,
    targetUrl: c.targetUrl,
    startTime: c.startTime,
    endTime: c.endTime,
    targetRequests: c.targetRequests,
    mode: c.mode,
    customBlocks: c.customBlocks,
    timezoneOffsetMinutes: c.timezoneOffsetMinutes,
    concurrency: c.concurrency,
    maxRetriesPerSlot: c.maxRetriesPerSlot,
    retryBackoffMs: c.retryBackoffMs,
    scheduleIdx: c.scheduleIdx,
    attempted: c.attempted,
    failedAttempts: c.failedAttempts,
    successfulSlots: [...c.successfulSlots],
    exhaustedSlots: [...c.exhaustedSlots],
    inFlightJobs: [...c.inFlightJobs.entries()],
    retryQueue: c.retryQueue,
    latencies: c.latencies.slice(-1000),
    logs: c.logs.slice(-100),
    status: c.status,
    createdAt: c.createdAt,
    endedAt: c.endedAt || null,
    telegramNotified: !!c.telegramNotified
  };
}

function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  store.save([...campaigns.values()].map(serializeCampaign));
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 250);
  persistTimer.unref?.();
}

function emitCampaign(c) {
  io.emit('campaign-update', publicCampaign(c));
}

function log(c, message, type = 'info') {
  const item = { campaignId: c.id, at: Date.now(), message, type };
  c.logs.push(item);
  if (c.logs.length > 300) c.logs.shift();
  io.emit('campaign-log', item);
  schedulePersist();
}

function normalizedStatus(snapshot) {
  if (['completed', 'partial', 'stopped', 'expired'].includes(snapshot.status)) return snapshot.status;
  if (Date.now() >= snapshot.endTime) return 'expired';
  return Date.now() >= snapshot.startTime ? 'running' : 'waiting';
}

function makeCampaign(source) {
  const mode = ['smart', 'even', 'custom'].includes(source.mode) ? source.mode : 'smart';
  const schedule = generateSchedule({
    startTime: source.startTime,
    endTime: source.endTime,
    targetRequests: source.targetRequests,
    mode,
    customBlocks: source.customBlocks || null,
    timezoneOffsetMinutes: source.timezoneOffsetMinutes
  });
  const c = {
    id: source.id || crypto.randomUUID(),
    name: String(source.name || 'Campaign').slice(0, 80),
    targetUrl: source.targetUrl,
    startTime: Number(source.startTime),
    endTime: Number(source.endTime),
    targetRequests: Number(source.targetRequests),
    mode,
    customBlocks: source.customBlocks || null,
    timezoneOffsetMinutes: Number.isFinite(Number(source.timezoneOffsetMinutes)) ? Number(source.timezoneOffsetMinutes) : null,
    concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, Number(source.concurrency || 10))),
    maxRetriesPerSlot: Math.max(0, Math.min(5, Number(source.maxRetriesPerSlot ?? MAX_RETRIES_PER_SLOT))),
    retryBackoffMs: Math.max(250, Math.min(30000, Number(source.retryBackoffMs ?? RETRY_BACKOFF_MS))),
    schedule,
    scheduleIdx: Math.max(0, Math.min(schedule.length, Number(source.scheduleIdx || 0))),
    attempted: Math.max(0, Number(source.attempted || 0)),
    failedAttempts: Math.max(0, Number(source.failedAttempts || 0)),
    successfulSlots: new Set(Array.isArray(source.successfulSlots) ? source.successfulSlots : []),
    exhaustedSlots: new Set(Array.isArray(source.exhaustedSlots) ? source.exhaustedSlots : []),
    inFlightJobs: new Map(),
    retryQueue: Array.isArray(source.retryQueue) ? source.retryQueue.filter(x => Number.isInteger(x.slotId)) : [],
    latencies: Array.isArray(source.latencies) ? source.latencies.slice(-1000) : [],
    logs: Array.isArray(source.logs) ? source.logs.slice(-100) : [],
    status: normalizedStatus(source),
    createdAt: Number(source.createdAt || Date.now()),
    endedAt: source.endedAt || null,
    telegramNotified: !!source.telegramNotified,
    pool: new RequestPool(Math.min(MAX_CONCURRENCY, Math.max(1, Number(source.concurrency || 10)))),
    tickBusy: false
  };

  if (!['completed', 'partial', 'stopped', 'expired'].includes(c.status)) {
    for (const [slotId, attempt] of Array.isArray(source.inFlightJobs) ? source.inFlightJobs : []) {
      if (!c.successfulSlots.has(slotId) && !c.exhaustedSlots.has(slotId)) {
        c.retryQueue.push({ slotId: Number(slotId), attempt: Number(attempt || 0), dueAt: Date.now() });
      }
    }
  }
  return c;
}

for (const snapshot of store.load()) {
  try {
    const target = validateTargetUrl(snapshot.targetUrl);
    if (!target.ok) continue;
    const c = makeCampaign(snapshot);
    campaigns.set(c.id, c);
  } catch (error) {
    console.error('[state] campaign restore failed:', error.message);
  }
}

function requireAuth(req, res, next) {
  req.user = auth.userFromCookie(req.headers.cookie || '');
  const publicPath = req.path === '/login.html' || req.path === '/login.js' || req.path === '/style.css' || req.path === '/api/login' || req.path.startsWith('/socket.io/');
  if (publicPath || req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Chỉ admin được phép thay đổi campaign.' });
  next();
}

app.use(requireAuth);

app.post('/api/login', (req, res) => {
  const result = auth.login(String(req.body?.username || ''), String(req.body?.password || ''));
  if (!result) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu.' });
  if (auth.enabled) {
    res.cookie('session_token', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 3600 * 1000
    });
  }
  res.json({ ok: true, user: result.user });
});

app.post('/api/logout', (req, res) => {
  auth.logout(req.headers.cookie || '');
  res.clearCookie('session_token', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = req.user || auth.userFromCookie(req.headers.cookie || '');
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user, authEnabled: auth.enabled });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/campaigns', (_req, res) => {
  res.json([...campaigns.values()].map(publicCampaign));
});

app.post('/api/campaigns', requireAdmin, (req, res) => {
  const body = req.body || {};
  const targetCheck = validateTargetUrl(body.targetUrl);
  if (!targetCheck.ok) return res.status(400).json({ error: targetCheck.reason });

  const startTime = Number(body.startTime);
  const endTime = Number(body.endTime);
  const targetRequests = Number.parseInt(body.targetRequests, 10);
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Number.parseInt(body.concurrency, 10) || 10));
  const mode = ['smart', 'even', 'custom'].includes(body.mode) ? body.mode : 'smart';
  const customBlocks = mode === 'custom' && body.customBlocks && typeof body.customBlocks === 'object' ? body.customBlocks : null;
  const timezoneOffsetMinutes = Number.isFinite(Number(body.timezoneOffsetMinutes)) ? Number(body.timezoneOffsetMinutes) : null;

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    return res.status(400).json({ error: 'Khoảng thời gian không hợp lệ.' });
  }
  if ((endTime - startTime) / 1000 < MIN_CAMPAIGN_SECONDS) {
    return res.status(400).json({ error: `Campaign phải kéo dài ít nhất ${MIN_CAMPAIGN_SECONDS}s.` });
  }
  if (!Number.isInteger(targetRequests) || targetRequests < 1 || targetRequests > MAX_CAMPAIGN_REQUESTS) {
    return res.status(400).json({ error: `targetRequests phải trong 1..${MAX_CAMPAIGN_REQUESTS}.` });
  }

  const campaign = makeCampaign({
    id: crypto.randomUUID(),
    name: String(body.name || `Campaign ${campaigns.size + 1}`).slice(0, 80),
    targetUrl: targetCheck.url.toString(),
    startTime, endTime, targetRequests, mode, customBlocks, timezoneOffsetMinutes, concurrency,
    maxRetriesPerSlot: body.maxRetriesPerSlot ?? MAX_RETRIES_PER_SLOT,
    retryBackoffMs: body.retryBackoffMs ?? RETRY_BACKOFF_MS,
    status: Date.now() >= startTime ? 'running' : 'waiting',
    createdAt: Date.now()
  });
  if (campaign.schedule.length !== targetRequests) return res.status(500).json({ error: 'Không tạo được lịch chính xác.' });
  campaigns.set(campaign.id, campaign);
  log(campaign, `Đã tạo ${targetRequests} request, concurrency=${concurrency}, mode=${mode}.`, 'system');
  persistNow();
  emitCampaign(campaign);
  res.status(201).json(publicCampaign(campaign));
});

app.post('/api/campaigns/:id/stop', requireAdmin, (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Không tìm thấy campaign.' });
  if (!['completed', 'partial', 'stopped', 'expired'].includes(c.status)) {
    c.status = 'stopped';
    c.endedAt = Date.now();
    c.retryQueue.length = 0;
    c.pool.stop();
    log(c, 'Đã dừng campaign.', 'warn');
    persistNow();
    emitCampaign(c);
  }
  res.json(publicCampaign(c));
});

app.get('/api/campaigns/:id/report', (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).send('Campaign not found');
  const report = [
    'CAMPAIGN REPORT',
    `Name: ${c.name}`,
    `Target URL: ${c.targetUrl}`,
    `Status: ${c.status}`,
    `Mode: ${c.mode}`,
    `Start: ${new Date(c.startTime).toISOString()}`,
    `End: ${new Date(c.endTime).toISOString()}`,
    `Target requests: ${c.targetRequests}`,
    `Successful slots: ${c.successfulSlots.size}`,
    `Attempted HTTP requests: ${c.attempted}`,
    `Failed attempts: ${c.failedAttempts}`,
    `Exhausted slots: ${c.exhaustedSlots.size}`,
    `p50 latency: ${percentile(c.latencies, 0.50) ?? 'N/A'} ms`,
    `p95 latency: ${percentile(c.latencies, 0.95) ?? 'N/A'} ms`
  ].join('\n');
  res.type('text/plain').set('Content-Disposition', `attachment; filename="campaign-${c.id}.txt"`).send(report);
});

app.get('/api/preview', (req, res) => {
  let customBlocks = null;
  if (req.query.customBlocks) {
    try { customBlocks = JSON.parse(String(req.query.customBlocks)); } catch {}
  }
  res.json(buildDistribution({
    startTime: Number(req.query.startTime),
    endTime: Number(req.query.endTime),
    targetRequests: Number(req.query.targetRequests),
    mode: ['smart', 'even', 'custom'].includes(req.query.mode) ? req.query.mode : 'smart',
    customBlocks,
    timezoneOffsetMinutes: Number(req.query.timezoneOffsetMinutes)
  }));
});

app.get('/__local_test_target', (_req, res) => res.status(200).send('ok'));

function queueRetry(c, job) {
  const nextAttempt = job.attempt + 1;
  const dueAt = Date.now() + c.retryBackoffMs;
  if (c.status === 'running' && nextAttempt <= c.maxRetriesPerSlot && dueAt < c.endTime) {
    c.retryQueue.push({ slotId: job.slotId, attempt: nextAttempt, dueAt });
    c.retryQueue.sort((a, b) => a.dueAt - b.dueAt);
    log(c, `Slot ${job.slotId} lỗi, retry ${nextAttempt}/${c.maxRetriesPerSlot}.`, 'warn');
  } else {
    c.exhaustedSlots.add(job.slotId);
    log(c, `Slot ${job.slotId} không thể retry thêm.`, 'error');
  }
}

async function runSlot(c, job) {
  c.attempted += 1;
  c.inFlightJobs.set(job.slotId, job.attempt);
  schedulePersist();
  emitCampaign(c);

  const result = await requestOnce(c.targetUrl, { timeoutMs: REQUEST_TIMEOUT_MS });
  c.inFlightJobs.delete(job.slotId);
  if (result.ok) {
    c.successfulSlots.add(job.slotId);
    c.exhaustedSlots.delete(job.slotId);
  } else {
    c.failedAttempts += 1;
    queueRetry(c, job);
  }
  if (Number.isFinite(result.latencyMs)) {
    c.latencies.push(result.latencyMs);
    if (c.latencies.length > 5000) c.latencies.shift();
  }
  if (!result.ok) {
    log(c, `Request lỗi${result.statusCode ? ` HTTP ${result.statusCode}` : ''}${result.error ? `: ${result.error}` : ''}`, 'error');
  }
  schedulePersist();
  emitCampaign(c);
}

function terminalSlots(c) {
  return c.successfulSlots.size + c.exhaustedSlots.size;
}

function finalizeCampaign(c, forcedStatus = null) {
  if (['completed', 'partial', 'stopped', 'expired'].includes(c.status)) return;
  c.status = forcedStatus || (c.successfulSlots.size === c.targetRequests ? 'completed' : 'partial');
  c.endedAt = Date.now();
  c.retryQueue.length = 0;
  c.pool.clearPending();
  log(c, c.status === 'completed'
    ? `Hoàn thành ${c.successfulSlots.size}/${c.targetRequests} slot.`
    : `Kết thúc ${c.successfulSlots.size}/${c.targetRequests} slot thành công.`,
  c.status === 'completed' ? 'success' : 'warn');
  const shouldNotify = !c.telegramNotified;
  if (shouldNotify) c.telegramNotified = true;
  persistNow();
  emitCampaign(c);
  if (shouldNotify) sendTelegramSummary({ ...publicCampaign(c), name: c.name, status: c.status }).catch(() => {});
}

async function tickCampaign(c) {
  if (c.tickBusy || ['completed', 'partial', 'stopped', 'expired'].includes(c.status)) return;
  c.tickBusy = true;
  try {
    const now = Date.now();
    if (c.status === 'waiting') {
      if (now < c.startTime) return;
      c.status = 'running';
      log(c, 'Campaign bắt đầu.', 'system');
    }

    if (now >= c.endTime) {
      c.retryQueue.length = 0;
      if (c.pool.active === 0 && c.inFlightJobs.size === 0) {
        finalizeCampaign(c, c.successfulSlots.size === c.targetRequests ? 'completed' : 'expired');
      }
      return;
    }

    const globalFreeSlots = getGlobalFreeSlots(campaigns.values(), MAX_CONCURRENCY);
    let capacity = Math.min(c.pool.freeSlots, globalFreeSlots);

    while (capacity > 0) {
      const retryIndex = c.retryQueue.findIndex(job => job.dueAt <= Date.now() && !c.successfulSlots.has(job.slotId) && !c.inFlightJobs.has(job.slotId));
      if (retryIndex >= 0) {
        const job = c.retryQueue.splice(retryIndex, 1)[0];
        c.inFlightJobs.set(job.slotId, job.attempt);
        c.pool.enqueue(() => runSlot(c, job));
        capacity -= 1;
        continue;
      }

      if (c.scheduleIdx >= c.schedule.length || c.schedule[c.scheduleIdx] > Date.now()) break;
      const slotId = c.scheduleIdx++;
      if (c.successfulSlots.has(slotId) || c.exhaustedSlots.has(slotId) || c.inFlightJobs.has(slotId)) continue;
      const job = { slotId, attempt: 0, dueAt: Date.now() };
      c.inFlightJobs.set(slotId, 0);
      c.pool.enqueue(() => runSlot(c, job));
      capacity -= 1;
    }

    if (c.scheduleIdx >= c.schedule.length && terminalSlots(c) >= c.targetRequests && c.pool.active === 0 && c.retryQueue.length === 0 && c.inFlightJobs.size === 0) {
      finalizeCampaign(c);
    }
    schedulePersist();
    emitCampaign(c);
  } finally {
    c.tickBusy = false;
  }
}

setInterval(() => {
  for (const c of campaigns.values()) tickCampaign(c).catch(err => log(c, `Scheduler error: ${err.message}`, 'error'));
}, 200).unref();

io.use((socket, next) => {
  const user = auth.userFromCookie(socket.handshake.headers.cookie || '');
  if (!user) return next(new Error('Unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  socket.emit('session', { user: socket.user, authEnabled: auth.enabled });
  socket.emit('campaigns-snapshot', [...campaigns.values()].map(publicCampaign));
});

process.on('SIGTERM', () => { try { persistNow(); } finally { process.exit(0); } });
process.on('SIGINT', () => { try { persistNow(); } finally { process.exit(0); } });

server.listen(PORT, HOST, () => {
  console.log(`Scheduled Loadtest Dashboard: http://${HOST}:${PORT}`);
  console.log(`Campaigns restored: ${campaigns.size}; global concurrency cap: ${MAX_CONCURRENCY}`);
  if (!auth.enabled) console.log('AUTH_ENABLED=false: local session runs as admin. Enable auth before exposing through a reverse proxy.');
  if (!process.env.ALLOWED_TARGET_HOSTS) console.log('External targets are disabled. Set ALLOWED_TARGET_HOSTS to exact authorized hostnames.');
});
