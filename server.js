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

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const campaigns = new Map();

function publicCampaign(c) {
  return {
    id: c.id,
    name: c.name,
    targetUrl: c.targetUrl,
    startTime: c.startTime,
    endTime: c.endTime,
    targetRequests: c.targetRequests,
    mode: c.mode,
    concurrency: c.concurrency,
    status: c.status,
    scheduled: c.schedule.length,
    dispatched: c.scheduleIdx,
    attempted: c.attempted,
    success: c.success,
    failed: c.failed,
    activeWorkers: c.pool.active,
    globalActiveWorkers: countActiveWorkers(campaigns.values()),
    globalMaxConcurrency: MAX_CONCURRENCY,
    pendingWorkers: c.pool.queue.length,
    p50ApproxMs: percentile(c.latencies, 0.50),
    p95ApproxMs: percentile(c.latencies, 0.95)
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]);
}

function emitCampaign(c) {
  io.emit('campaign-update', publicCampaign(c));
}

function log(c, message, type = 'info') {
  const item = { campaignId: c.id, at: Date.now(), message, type };
  c.logs.push(item);
  if (c.logs.length > 300) c.logs.shift();
  io.emit('campaign-log', item);
}

app.get('/api/campaigns', (_req, res) => {
  res.json([...campaigns.values()].map(publicCampaign));
});

app.post('/api/campaigns', (req, res) => {
  const body = req.body || {};
  const targetCheck = validateTargetUrl(body.targetUrl);
  if (!targetCheck.ok) return res.status(400).json({ error: targetCheck.reason });

  const startTime = Number(body.startTime);
  const endTime = Number(body.endTime);
  const targetRequests = Number.parseInt(body.targetRequests, 10);
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Number.parseInt(body.concurrency, 10) || 10));
  const mode = body.mode === 'even' ? 'even' : 'smart';
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

  const schedule = generateSchedule({ startTime, endTime, targetRequests, mode, timezoneOffsetMinutes });
  if (schedule.length !== targetRequests) {
    return res.status(500).json({ error: 'Không tạo được lịch chính xác.' });
  }

  const id = crypto.randomUUID();
  const campaign = {
    id,
    name: String(body.name || `Campaign ${campaigns.size + 1}`).slice(0, 80),
    targetUrl: targetCheck.url.toString(),
    startTime,
    endTime,
    targetRequests,
    mode,
    timezoneOffsetMinutes,
    concurrency,
    schedule,
    scheduleIdx: 0,
    attempted: 0,
    success: 0,
    failed: 0,
    latencies: [],
    logs: [],
    status: Date.now() >= startTime ? 'running' : 'waiting',
    pool: new RequestPool(concurrency),
    tickBusy: false
  };
  campaigns.set(id, campaign);
  log(campaign, `Đã tạo ${targetRequests} request, concurrency=${concurrency}, mode=${mode}.`, 'system');
  emitCampaign(campaign);
  res.status(201).json(publicCampaign(campaign));
});

app.post('/api/campaigns/:id/stop', (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Không tìm thấy campaign.' });
  if (!['completed', 'expired', 'stopped'].includes(c.status)) {
    c.status = 'stopped';
    c.pool.stop();
    log(c, 'Đã dừng campaign.', 'warn');
    emitCampaign(c);
  }
  res.json(publicCampaign(c));
});

app.get('/api/preview', (req, res) => {
  const dist = buildDistribution({
    startTime: Number(req.query.startTime),
    endTime: Number(req.query.endTime),
    targetRequests: Number(req.query.targetRequests),
    mode: req.query.mode === 'even' ? 'even' : 'smart',
    timezoneOffsetMinutes: Number(req.query.timezoneOffsetMinutes)
  });
  res.json(dist);
});

app.get('/__local_test_target', (_req, res) => res.status(200).send('ok'));

async function runSlot(c) {
  c.attempted += 1;
  emitCampaign(c);
  const result = await requestOnce(c.targetUrl, { timeoutMs: REQUEST_TIMEOUT_MS });
  if (result.ok) c.success += 1;
  else c.failed += 1;
  if (Number.isFinite(result.latencyMs)) {
    c.latencies.push(result.latencyMs);
    if (c.latencies.length > 5000) c.latencies.shift();
  }
  if (!result.ok) {
    log(c, `Request lỗi${result.statusCode ? ` HTTP ${result.statusCode}` : ''}${result.error ? `: ${result.error}` : ''}`, 'error');
  }
  emitCampaign(c);
}

async function tickCampaign(c) {
  if (c.tickBusy || ['completed', 'expired', 'stopped'].includes(c.status)) return;
  c.tickBusy = true;
  try {
    const now = Date.now();
    if (c.status === 'waiting') {
      if (now < c.startTime) return;
      c.status = 'running';
      log(c, 'Campaign bắt đầu.', 'system');
    }

    if (now >= c.endTime) {
      c.status = c.attempted >= c.targetRequests ? 'completed' : 'expired';
      c.pool.clearPending();
      log(c, c.status === 'completed' ? 'Campaign hoàn thành.' : `Hết giờ: đã gửi ${c.attempted}/${c.targetRequests} request.`, c.status === 'completed' ? 'success' : 'warn');
      emitCampaign(c);
      return;
    }

    const globalFreeSlots = getGlobalFreeSlots(campaigns.values(), MAX_CONCURRENCY);
    let capacity = Math.min(c.pool.freeSlots, globalFreeSlots);
    while (capacity > 0 && c.scheduleIdx < c.schedule.length && c.schedule[c.scheduleIdx] <= now) {
      c.scheduleIdx += 1;
      c.pool.enqueue(() => runSlot(c));
      capacity -= 1;
    }

    if (c.scheduleIdx >= c.schedule.length && c.attempted >= c.targetRequests && c.pool.active === 0 && c.pool.queue.length === 0) {
      c.status = 'completed';
      log(c, 'Campaign hoàn thành đủ số request.', 'success');
    }
    emitCampaign(c);
  } finally {
    c.tickBusy = false;
  }
}

setInterval(() => {
  for (const c of campaigns.values()) tickCampaign(c).catch(err => log(c, `Scheduler error: ${err.message}`, 'error'));
}, 200).unref();

io.on('connection', (socket) => {
  socket.emit('campaigns-snapshot', [...campaigns.values()].map(publicCampaign));
});

server.listen(PORT, HOST, () => {
  console.log(`Scheduled Loadtest Dashboard: http://${HOST}:${PORT}`);
  if (!process.env.ALLOWED_TARGET_HOSTS) {
    console.log('External targets are disabled. Set ALLOWED_TARGET_HOSTS to exact authorized hostnames.');
  }
});
