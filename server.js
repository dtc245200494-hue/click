const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const {
    calculateAdaptiveNextInterval,
    buildTimeDistribution,
    formatDuration,
    hasTimezoneOffset
} = require('./timeDistribution');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = process.env.PORT || 3005;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── HTTP Keep-Alive Agents ────────────────────────────────────────────────────
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100,
    keepAliveMsecs: 30000
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    keepAliveMsecs: 30000,
    rejectUnauthorized: false // Cho phép test cả cert self-signed nội bộ
});

/**
 * Super lightweight HTTP Request Executor
 */
function executeHttpRequest({ url, method = 'GET', timeoutMs = 8000, headers = {} }) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (err) {
            return resolve({
                success: false,
                statusCode: null,
                latencyMs: 0,
                error: `Invalid URL: ${err.message}`
            });
        }

        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;
        const agent = isHttps ? httpsAgent : httpAgent;

        const defaultHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 BenchmarkTester/2.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            ...headers
        };

        const options = {
            protocol: parsedUrl.protocol,
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method.toUpperCase(),
            headers: defaultHeaders,
            agent,
            timeout: timeoutMs
        };

        const req = client.request(options, (res) => {
            // Drain data to allow socket reuse
            res.on('data', () => {});
            res.on('end', () => {
                const latencyMs = Date.now() - startTime;
                const success = res.statusCode >= 200 && res.statusCode < 400;
                resolve({
                    success,
                    statusCode: res.statusCode,
                    latencyMs,
                    error: success ? null : `HTTP ${res.statusCode}`
                });
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`Timeout (${timeoutMs}ms)`));
        });

        req.on('error', (err) => {
            const latencyMs = Date.now() - startTime;
            resolve({
                success: false,
                statusCode: null,
                latencyMs,
                error: err.message
            });
        });

        req.end();
    });
}

// ─── Campaigns Storage ─────────────────────────────────────────────────────────
const CAMPAIGNS_DIR = path.join(__dirname, 'campaigns');
if (!fs.existsSync(CAMPAIGNS_DIR)) fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });

const campaigns = new Map();

function createCampaignState(id, rawConfig) {
    const targetRequests = parseInt(rawConfig.targetRequests || rawConfig.targetClicks, 10) || 100;
    const startTime = typeof rawConfig.startTime === 'number' ? rawConfig.startTime : new Date(rawConfig.startTime).getTime();
    const endTime = typeof rawConfig.endTime === 'number' ? rawConfig.endTime : new Date(rawConfig.endTime).getTime();
    const scheduleMode = rawConfig.scheduleMode === 'even' ? 'even' : 'smart';
    const timeoutMs = parseInt(rawConfig.timeoutMs, 10) || 8000;
    const maxConcurrent = Math.max(1, Math.min(20, parseInt(rawConfig.maxConcurrent, 10) || 3));
    const timezoneOffsetMinutes = hasTimezoneOffset(rawConfig.timezoneOffsetMinutes) ? Number(rawConfig.timezoneOffsetMinutes) : null;

    const config = {
        name: rawConfig.name || `Chiến dịch ${id}`,
        targetUrl: rawConfig.targetUrl || '',
        targetRequests,
        startTime,
        endTime,
        scheduleMode,
        timeoutMs,
        maxConcurrent,
        timezoneOffsetMinutes,
        maxRetries: Number.isInteger(rawConfig.maxRetries) ? Math.max(0, Math.min(3, rawConfig.maxRetries)) : 1,
        retryBackoffMs: 2000
    };

    const now = Date.now();
    let status = 'waiting';
    if (now >= endTime) status = 'expired';
    else if (now >= startTime) status = 'running';

    return {
        id,
        config,
        status,
        startTime,
        endTime,
        actualStartTime: status === 'running' ? now : null,
        actualEndTime: null,
        targetRequests,
        successRequests: 0,
        failedRequests: 0,
        totalDispatched: 0,
        activeWorkers: 0,
        nextScheduledTime: null,
        lastScheduledIntervalMs: 0,
        currentRatePerHour: 0,
        latencyHistory: [],
        retryQueue: [],
        lastTickTime: now,
        _tickRunning: false
    };
}

function loadCampaignsFromDisk() {
    try {
        const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
            const id = file.replace('.json', '');
            try {
                const config = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, file), 'utf-8'));
                if (!config.targetUrl || !config.startTime || !config.endTime) continue;
                const state = createCampaignState(id, config);
                campaigns.set(id, state);
            } catch (e) {
                console.error(`[Load] Error reading ${file}:`, e.message);
            }
        }
        console.log(`[Storage] Đã tải ${campaigns.size} chiến dịch từ đĩa.`);
    } catch (e) {
        console.error('[Storage] Lỗi đọc thư mục campaigns:', e.message);
    }
}

function saveCampaignConfig(id, config) {
    try {
        fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${id}.json`), JSON.stringify(config, null, 4), 'utf-8');
    } catch (e) {
        console.error(`[Storage] Lỗi lưu chiến dịch ${id}:`, e.message);
    }
}

function deleteCampaignFile(id) {
    try {
        const p = path.join(CAMPAIGNS_DIR, `${id}.json`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {}
}

function generateCampaignId() {
    const existingIds = Array.from(campaigns.keys()).map(Number).filter(n => !isNaN(n));
    if (existingIds.length === 0) return '1';
    return String(Math.max(...existingIds) + 1);
}

// ─── Real-time Logging & Socket.IO ─────────────────────────────────────────────
function sendLog(campaignId, text, type = 'info', meta = null) {
    const timestamp = new Date().toLocaleTimeString('vi-VN');
    const logObj = { campaignId, text, type, timestamp, meta };
    console.log(`[C${campaignId}][${type.toUpperCase()}] ${text}`);
    io.emit('log', logObj);
}

function emitStats(campaignId) {
    const campaign = campaigns.get(campaignId);
    if (!campaign) return;

    const now = Date.now();
    const timeLeft = campaign.endTime ? Math.max(0, campaign.endTime - now) : 0;
    const timeRemainingStr = formatDuration(timeLeft);
    const etaStr = campaign.endTime ? new Date(campaign.endTime).toLocaleTimeString('vi-VN') : '--:--';

    // Calculate rolling avg latency
    const recentLatencies = campaign.latencyHistory.slice(-20);
    const avgLatencyMs = recentLatencies.length > 0
        ? Math.round(recentLatencies.reduce((a, b) => a + b, 0) / recentLatencies.length)
        : 0;

    const remainingRequests = Math.max(0, campaign.targetRequests - campaign.successRequests);
    const progressPercent = campaign.targetRequests > 0
        ? Number(((campaign.successRequests / campaign.targetRequests) * 100).toFixed(1))
        : 0;

    io.emit('stats-update', {
        campaignId,
        status: campaign.status,
        target: campaign.targetRequests,
        success: campaign.successRequests,
        failed: campaign.failedRequests,
        remaining: remainingRequests,
        activeWorkers: campaign.activeWorkers,
        maxConcurrent: campaign.config.maxConcurrent,
        progressPercent,
        avgLatencyMs,
        currentRatePerHour: campaign.currentRatePerHour,
        nextIntervalSec: campaign.lastScheduledIntervalMs ? Number((campaign.lastScheduledIntervalMs / 1000).toFixed(1)) : 0,
        etaStr,
        timeRemainingStr,
        timeRemainingMs: timeLeft,
        actualStartTime: campaign.actualStartTime,
        actualEndTime: campaign.actualEndTime
    });
}

function emitCampaignList() {
    const list = [];
    for (const [id, c] of campaigns.entries()) {
        const remaining = Math.max(0, c.targetRequests - c.successRequests);
        const progressPercent = c.targetRequests > 0 ? Number(((c.successRequests / c.targetRequests) * 100).toFixed(1)) : 0;
        list.push({
            id,
            name: c.config.name,
            targetUrl: c.config.targetUrl,
            status: c.status,
            targetRequests: c.targetRequests,
            successRequests: c.successRequests,
            failedRequests: c.failedRequests,
            remaining,
            progressPercent,
            scheduleMode: c.config.scheduleMode,
            maxConcurrent: c.config.maxConcurrent,
            timeoutMs: c.config.timeoutMs,
            startTime: c.config.startTime,
            endTime: c.config.endTime,
            config: c.config
        });
    }
    io.emit('campaigns-list', list);
}

// ─── Lifecycle Management ──────────────────────────────────────────────────────
function completeCampaign(campaignId, reason) {
    const campaign = campaigns.get(campaignId);
    if (!campaign) return;
    if (['stopped', 'completed', 'expired'].includes(campaign.status)) return;

    campaign.status = reason;
    campaign.actualEndTime = Date.now();
    if (!campaign.actualStartTime) campaign.actualStartTime = campaign.startTime || Date.now();

    const messages = {
        completed: `Chiến dịch ${campaignId} HOÀN THÀNH XUẤT SẮC! Đạt ${campaign.successRequests}/${campaign.targetRequests} requests.`,
        expired: `Chiến dịch ${campaignId} ĐÃ HẾT GIỜ. Đạt ${campaign.successRequests}/${campaign.targetRequests} requests.`,
        stopped: `Chiến dịch ${campaignId} ĐÃ DỪNG LẠI. Đạt ${campaign.successRequests}/${campaign.targetRequests} requests.`
    };

    sendLog(campaignId, messages[reason] || `Kết thúc: ${reason}`, reason === 'completed' ? 'success' : 'warn');
    io.emit('status-update', { campaignId, status: campaign.status, isRunning: false });
    emitStats(campaignId);
    emitCampaignList();
}

// ─── HTTP Request Dispatcher ──────────────────────────────────────────────────
async function dispatchRequest(campaignId, isRetry = false, retryAttempt = 0) {
    const campaign = campaigns.get(campaignId);
    if (!campaign || campaign.status !== 'running') return;

    campaign.activeWorkers++;
    campaign.totalDispatched++;
    emitStats(campaignId);

    const targetUrl = campaign.config.targetUrl;
    const timeoutMs = campaign.config.timeoutMs || 8000;

    try {
        const result = await executeHttpRequest({
            url: targetUrl,
            method: 'GET',
            timeoutMs
        });

        if (result.success) {
            campaign.successRequests++;
            campaign.latencyHistory.push(result.latencyMs);
            if (campaign.latencyHistory.length > 50) campaign.latencyHistory.shift();

            sendLog(campaignId, `[200 OK] ${targetUrl} (${result.latencyMs}ms)`, 'success', {
                statusCode: result.statusCode,
                latencyMs: result.latencyMs,
                isRetry
            });
        } else {
            campaign.failedRequests++;
            sendLog(campaignId, `[Lỗi] ${targetUrl}: ${result.error || `HTTP ${result.statusCode}`} (${result.latencyMs}ms)`, 'error', {
                statusCode: result.statusCode,
                error: result.error,
                latencyMs: result.latencyMs
            });

            // Handle Retry if within campaign window
            const nextAttempt = retryAttempt + 1;
            const retryAt = Date.now() + (campaign.config.retryBackoffMs || 2000);
            if (nextAttempt <= (campaign.config.maxRetries || 1) && retryAt < campaign.endTime) {
                campaign.retryQueue.push({
                    attempt: nextAttempt,
                    dueAt: retryAt
                });
                sendLog(campaignId, `Sẽ thử lại lần ${nextAttempt}/${campaign.config.maxRetries} sau 2s...`, 'warn');
            }
        }
    } catch (err) {
        campaign.failedRequests++;
        sendLog(campaignId, `[Ngoại lệ] ${err.message}`, 'error');
    } finally {
        campaign.activeWorkers = Math.max(0, campaign.activeWorkers - 1);
        emitStats(campaignId);

        // Check completion criteria
        if (campaign.successRequests >= campaign.targetRequests) {
            completeCampaign(campaignId, 'completed');
        } else if (Date.now() >= campaign.endTime && campaign.activeWorkers === 0) {
            completeCampaign(campaignId, campaign.successRequests >= campaign.targetRequests ? 'completed' : 'expired');
        }
    }
}

// ─── Adaptive Engine Tick ──────────────────────────────────────────────────────
async function tickCampaign(campaignId) {
    const campaign = campaigns.get(campaignId);
    if (!campaign) return;
    if (['stopped', 'completed', 'expired', 'paused'].includes(campaign.status)) return;

    if (campaign._tickRunning) return;
    campaign._tickRunning = true;

    try {
        const now = Date.now();

        // 1. Completion check
        if (campaign.successRequests >= campaign.targetRequests) {
            completeCampaign(campaignId, 'completed');
            return;
        }

        // 2. Waiting check
        if (campaign.status === 'waiting') {
            if (now >= campaign.startTime) {
                campaign.status = 'running';
                campaign.actualStartTime = now;
                sendLog(campaignId, `Bắt đầu chạy chiến dịch! Mục tiêu: ${campaign.targetRequests} requests.`, 'info');
                io.emit('status-update', { campaignId, status: 'running', isRunning: true });
                emitCampaignList();
            } else {
                emitStats(campaignId);
                return;
            }
        }

        // 3. Expire check
        if (now >= campaign.endTime) {
            if (campaign.activeWorkers === 0) {
                completeCampaign(campaignId, campaign.successRequests >= campaign.targetRequests ? 'completed' : 'expired');
            }
            emitStats(campaignId);
            return;
        }

        // 4. Clean expired retries
        campaign.retryQueue = campaign.retryQueue.filter(r => r.dueAt < campaign.endTime);

        // 5. Check concurrency availability
        const maxConcurrent = campaign.config.maxConcurrent || 3;
        if (campaign.activeWorkers >= maxConcurrent) {
            emitStats(campaignId);
            return;
        }

        // 6. Handle retries with priority
        const dueRetryIndex = campaign.retryQueue.findIndex(r => r.dueAt <= now);
        if (dueRetryIndex >= 0 && campaign.activeWorkers < maxConcurrent) {
            const retryJob = campaign.retryQueue.splice(dueRetryIndex, 1)[0];
            dispatchRequest(campaignId, true, retryJob.attempt);
            return;
        }

        // 7. Adaptive Pacing Calculation
        const remainingToTarget = Math.max(0, campaign.targetRequests - campaign.successRequests - campaign.activeWorkers);
        if (remainingToTarget <= 0) return;

        // Recalculate adaptive interval
        const adaptive = calculateAdaptiveNextInterval({
            now,
            endTime: campaign.endTime,
            remainingRequests: remainingToTarget,
            mode: campaign.config.scheduleMode,
            timezoneOffsetMinutes: campaign.config.timezoneOffsetMinutes
        });

        if (!adaptive.valid) return;

        campaign.currentRatePerHour = adaptive.currentRatePerHour;
        campaign.lastScheduledIntervalMs = adaptive.idealIntervalMs;

        // If nextScheduledTime has not been set or has arrived, fire request!
        if (campaign.nextScheduledTime === null || now >= campaign.nextScheduledTime) {
            // Schedule NEXT request using adaptive jittered interval
            campaign.nextScheduledTime = now + adaptive.jitteredIntervalMs;

            // Dispatch immediately
            dispatchRequest(campaignId, false, 0);
        }

        emitStats(campaignId);

    } finally {
        campaign._tickRunning = false;
    }
}

// Global master ticker (250ms)
setInterval(() => {
    for (const id of campaigns.keys()) {
        tickCampaign(id).catch(err => {
            console.error(`[Scheduler] Lỗi tick C${id}:`, err.message);
        });
    }
}, 250);

// ─── REST APIs ─────────────────────────────────────────────────────────────────

// List all campaigns
app.get('/api/campaigns', (req, res) => {
    const list = [];
    for (const [id, c] of campaigns.entries()) {
        const remaining = Math.max(0, c.targetRequests - c.successRequests);
        const progressPercent = c.targetRequests > 0 ? Number(((c.successRequests / c.targetRequests) * 100).toFixed(1)) : 0;
        list.push({
            id,
            name: c.config.name,
            targetUrl: c.config.targetUrl,
            status: c.status,
            targetRequests: c.targetRequests,
            successRequests: c.successRequests,
            failedRequests: c.failedRequests,
            remaining,
            progressPercent,
            scheduleMode: c.config.scheduleMode,
            maxConcurrent: c.config.maxConcurrent,
            timeoutMs: c.config.timeoutMs,
            startTime: c.config.startTime,
            endTime: c.config.endTime,
            config: c.config
        });
    }
    res.json({ success: true, data: list });
});

// Create campaign
app.post('/api/campaigns', (req, res) => {
    try {
        const body = req.body;
        if (!body.targetUrl) {
            return res.status(400).json({ success: false, message: 'targetUrl là bắt buộc' });
        }

        const id = generateCampaignId();
        const state = createCampaignState(id, body);
        campaigns.set(id, state);
        saveCampaignConfig(id, state.config);

        sendLog(id, `Đã tạo chiến dịch mới: "${state.config.name}" (${state.config.targetRequests} reqs, ${state.config.scheduleMode.toUpperCase()})`, 'info');
        emitCampaignList();
        emitStats(id);

        res.json({ success: true, id, campaign: state.config });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Update campaign
app.put('/api/campaigns/:id', (req, res) => {
    const id = req.params.id;
    const campaign = campaigns.get(id);
    if (!campaign) {
        return res.status(404).json({ success: false, message: 'Chiến dịch không tồn tại' });
    }

    try {
        const body = req.body;
        const newConfig = {
            ...campaign.config,
            name: body.name !== undefined ? body.name : campaign.config.name,
            targetUrl: body.targetUrl || campaign.config.targetUrl,
            targetRequests: parseInt(body.targetRequests, 10) || campaign.config.targetRequests,
            startTime: body.startTime ? (typeof body.startTime === 'number' ? body.startTime : new Date(body.startTime).getTime()) : campaign.config.startTime,
            endTime: body.endTime ? (typeof body.endTime === 'number' ? body.endTime : new Date(body.endTime).getTime()) : campaign.config.endTime,
            scheduleMode: body.scheduleMode === 'even' ? 'even' : 'smart',
            timeoutMs: parseInt(body.timeoutMs, 10) || campaign.config.timeoutMs,
            maxConcurrent: Math.max(1, Math.min(20, parseInt(body.maxConcurrent, 10) || campaign.config.maxConcurrent)),
            timezoneOffsetMinutes: hasTimezoneOffset(body.timezoneOffsetMinutes) ? Number(body.timezoneOffsetMinutes) : campaign.config.timezoneOffsetMinutes
        };

        campaign.config = newConfig;
        campaign.targetRequests = newConfig.targetRequests;
        campaign.startTime = newConfig.startTime;
        campaign.endTime = newConfig.endTime;
        saveCampaignConfig(id, newConfig);

        sendLog(id, `Cập nhật cấu hình chiến dịch thành công`, 'info');
        emitCampaignList();
        emitStats(id);

        res.json({ success: true, campaign: newConfig });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Delete campaign
app.delete('/api/campaigns/:id', (req, res) => {
    const id = req.params.id;
    if (!campaigns.has(id)) {
        return res.status(404).json({ success: false, message: 'Chiến dịch không tồn tại' });
    }

    campaigns.delete(id);
    deleteCampaignFile(id);
    emitCampaignList();
    res.json({ success: true, message: `Đã xóa chiến dịch ${id}` });
});

// Start / Resume campaign
app.post('/api/campaigns/:id/start', (req, res) => {
    const id = req.params.id;
    const campaign = campaigns.get(id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Chiến dịch không tồn tại' });

    const now = Date.now();
    if (now >= campaign.endTime) {
        return res.status(400).json({ success: false, message: 'Chiến dịch đã quá giờ kết thúc' });
    }

    campaign.status = now >= campaign.startTime ? 'running' : 'waiting';
    if (campaign.status === 'running' && !campaign.actualStartTime) {
        campaign.actualStartTime = now;
    }
    campaign.nextScheduledTime = null; // Re-evaluate immediately

    sendLog(id, `Khởi động/Tiếp tục chiến dịch`, 'info');
    emitCampaignList();
    emitStats(id);
    res.json({ success: true, status: campaign.status });
});

// Pause campaign
app.post('/api/campaigns/:id/pause', (req, res) => {
    const id = req.params.id;
    const campaign = campaigns.get(id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Chiến dịch không tồn tại' });

    campaign.status = 'paused';
    sendLog(id, `Tạm dừng chiến dịch`, 'warn');
    emitCampaignList();
    emitStats(id);
    res.json({ success: true, status: 'paused' });
});

// Stop campaign
app.post('/api/campaigns/:id/stop', (req, res) => {
    const id = req.params.id;
    completeCampaign(id, 'stopped');
    res.json({ success: true, status: 'stopped' });
});

// Reset campaign stats
app.post('/api/campaigns/:id/reset', (req, res) => {
    const id = req.params.id;
    const campaign = campaigns.get(id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Chiến dịch không tồn tại' });

    campaign.successRequests = 0;
    campaign.failedRequests = 0;
    campaign.totalDispatched = 0;
    campaign.latencyHistory = [];
    campaign.retryQueue = [];
    campaign.nextScheduledTime = null;

    const now = Date.now();
    if (now >= campaign.endTime) campaign.status = 'expired';
    else if (now >= campaign.startTime) campaign.status = 'running';
    else campaign.status = 'waiting';

    sendLog(id, `Đã làm mới (reset) tiến trình chiến dịch`, 'info');
    emitCampaignList();
    emitStats(id);
    res.json({ success: true, status: campaign.status });
});

// Distribution preview API
app.get('/api/preview-distribution', (req, res) => {
    try {
        const { startTime, endTime, targetRequests, mode, timezoneOffsetMinutes } = req.query;
        const dist = buildTimeDistribution({
            startTime: Number(startTime),
            endTime: Number(endTime),
            targetClicks: parseInt(targetRequests, 10),
            mode: mode || 'smart',
            timezoneOffsetMinutes: hasTimezoneOffset(timezoneOffsetMinutes) ? Number(timezoneOffsetMinutes) : null
        });
        res.json({ success: true, data: dist });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// URL Connectivity / Latency Ping Test API
app.post('/api/test-url', async (req, res) => {
    const { url, timeoutMs = 5000 } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'URL là bắt buộc' });

    const result = await executeHttpRequest({ url, timeoutMs });
    res.json(result);
});

// ─── Start Server ──────────────────────────────────────────────────────────────
loadCampaignsFromDisk();

server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 TRAFFIC BENCHMARK RUNNER 2.0 (SUPER LIGHTWEIGHT)`);
    console.log(`📡 Dashboard đang chạy tại: http://localhost:${PORT}`);
    console.log(`⚡ Sẵn sàng chạy load test HTTP với Even & Smart Distribution`);
    console.log(`======================================================\n`);
});
