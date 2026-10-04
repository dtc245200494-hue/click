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

const PORT = parseInt(process.env.PORT, 10) || 3005;
const HOST = process.env.HOST || '127.0.0.1'; // Bảo mật: Chỉ bind localhost

// ─── Socket.IO với CORS an toàn cho Localhost ──────────────────────────────────
const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            // Cho phép request cùng origin hoặc không có origin (local, curl)
            if (!origin) return callback(null, true);
            try {
                const parsed = new URL(origin);
                const allowed = ['localhost', '127.0.0.1'];
                if (allowed.includes(parsed.hostname)) {
                    return callback(null, true);
                }
            } catch (e) {}
            return callback(new Error('CORS disallowed'), false);
        }
    }
});

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
 * Super lightweight HTTP Request Executor with Keep-Alive
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
            // Drain stream to allow Keep-Alive socket reuse
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

// ─── Campaigns State & Persistent Storage ──────────────────────────────────────
const CAMPAIGNS_DIR = path.join(__dirname, 'campaigns');
if (!fs.existsSync(CAMPAIGNS_DIR)) fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });

const campaigns = new Map();
const dirtyCampaigns = new Set();
let persistDebounceTimer = null;

function serializeCampaign(c) {
    return {
        name: c.config.name,
        targetUrl: c.config.targetUrl,
        targetRequests: c.targetRequests,
        startTime: c.config.startTime,
        endTime: c.config.endTime,
        scheduleMode: c.config.scheduleMode,
        timeoutMs: c.config.timeoutMs,
        maxConcurrent: c.config.maxConcurrent,
        timezoneOffsetMinutes: c.config.timezoneOffsetMinutes,
        maxRetries: c.config.maxRetries,
        status: c.status,
        successRequests: c.successRequests,
        failedRequests: c.failedRequests,
        totalDispatched: c.totalDispatched,
        actualStartTime: c.actualStartTime,
        actualEndTime: c.actualEndTime
    };
}

function flushCampaignToDisk(id) {
    const campaign = campaigns.get(id);
    if (!campaign) return;
    try {
        const data = serializeCampaign(campaign);
        const tempPath = path.join(CAMPAIGNS_DIR, `${id}.json.tmp`);
        const targetPath = path.join(CAMPAIGNS_DIR, `${id}.json`);
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 4), 'utf-8');
        fs.renameSync(tempPath, targetPath); // Ghi file nguyên tử (Atomic write)
    } catch (e) {
        console.error(`[Storage] Lỗi lưu chiến dịch ${id}:`, e.message);
    }
}

function saveCampaignImmediate(id) {
    dirtyCampaigns.delete(id);
    flushCampaignToDisk(id);
}

function markCampaignDirty(id) {
    dirtyCampaigns.add(id);
    if (!persistDebounceTimer) {
        persistDebounceTimer = setTimeout(() => {
            persistDebounceTimer = null;
            for (const cid of dirtyCampaigns) {
                flushCampaignToDisk(cid);
            }
            dirtyCampaigns.clear();
        }, 1000); // Debounce 1s tránh nghẽn I/O đĩa
    }
}

function flushAllCampaignsSync() {
    if (persistDebounceTimer) {
        clearTimeout(persistDebounceTimer);
        persistDebounceTimer = null;
    }
    for (const [id, c] of campaigns.entries()) {
        try {
            const data = serializeCampaign(c);
            fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${id}.json`), JSON.stringify(data, null, 4), 'utf-8');
        } catch (e) {}
    }
}

process.on('SIGINT', () => {
    console.log('\n[Process] Nhận SIGINT, lưu trạng thái chiến dịch trước khi thoát...');
    flushAllCampaignsSync();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n[Process] Nhận SIGTERM, lưu trạng thái chiến dịch trước khi thoát...');
    flushAllCampaignsSync();
    process.exit(0);
});

function createCampaignState(id, rawConfig) {
    const targetRequests = parseInt(rawConfig.targetRequests || rawConfig.targetClicks, 10) || 100;
    const startTime = typeof rawConfig.startTime === 'number' ? rawConfig.startTime : new Date(rawConfig.startTime).getTime();
    const endTime = typeof rawConfig.endTime === 'number' ? rawConfig.endTime : new Date(rawConfig.endTime).getTime();
    const scheduleMode = rawConfig.scheduleMode === 'even' ? 'even' : 'smart';
    const timeoutMs = parseInt(rawConfig.timeoutMs, 10) || 8000;
    const maxConcurrent = Math.max(1, Math.min(20, parseInt(rawConfig.maxConcurrent, 10) || 3));
    const timezoneOffsetMinutes = hasTimezoneOffset(rawConfig.timezoneOffsetMinutes) ? Number(rawConfig.timezoneOffsetMinutes) : null;
    const maxRetries = Number.isInteger(rawConfig.maxRetries) ? Math.max(0, Math.min(3, rawConfig.maxRetries)) : 1;

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
        maxRetries,
        retryBackoffMs: 2000
    };

    // Khôi phục trạng thái đã chạy từ disk (Persistence)
    const savedSuccess = parseInt(rawConfig.successRequests, 10) || 0;
    const savedFailed = parseInt(rawConfig.failedRequests, 10) || 0;
    const savedDispatched = parseInt(rawConfig.totalDispatched, 10) || (savedSuccess + savedFailed);
    const savedActualStart = rawConfig.actualStartTime || null;
    const savedActualEnd = rawConfig.actualEndTime || null;
    const savedStatus = rawConfig.status;

    const now = Date.now();
    let status = 'waiting';

    if (['completed', 'stopped', 'expired'].includes(savedStatus)) {
        status = savedStatus;
    } else if (savedSuccess >= targetRequests) {
        status = 'completed';
    } else if (now >= endTime) {
        status = 'expired';
    } else if (savedStatus === 'paused') {
        status = 'paused';
    } else if (now >= startTime) {
        status = 'running';
    }

    return {
        id,
        config,
        status,
        startTime,
        endTime,
        actualStartTime: savedActualStart || (status === 'running' ? now : null),
        actualEndTime: savedActualEnd,
        targetRequests,
        successRequests: savedSuccess,
        failedRequests: savedFailed,
        totalDispatched: savedDispatched,
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
                console.log(`[Storage] Đã tải C${id}: ${state.config.name} (Tiến độ: ${state.successRequests}/${state.targetRequests}, Trạng thái: ${state.status})`);
            } catch (e) {
                console.error(`[Load] Lỗi đọc ${file}:`, e.message);
            }
        }
        console.log(`[Storage] Đã tải tổng cộng ${campaigns.size} chiến dịch từ đĩa.`);
    } catch (e) {
        console.error('[Storage] Lỗi đọc thư mục campaigns:', e.message);
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

    // Rolling avg latency
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
        totalDispatched: campaign.totalDispatched,
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
            totalDispatched: c.totalDispatched,
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
    campaign.retryQueue = [];
    campaign.nextScheduledTime = null;

    const messages = {
        completed: `Chiến dịch ${campaignId} HOÀN THÀNH XUẤT SẮC! Đạt ${campaign.successRequests}/${campaign.targetRequests} thành công (Tổng gửi: ${campaign.totalDispatched} reqs).`,
        expired: `Chiến dịch ${campaignId} ĐÃ HẾT GIỜ. Đạt ${campaign.successRequests}/${campaign.targetRequests} thành công (Tổng gửi: ${campaign.totalDispatched} reqs).`,
        stopped: `Chiến dịch ${campaignId} ĐÃ DỪNG LẠI. Đạt ${campaign.successRequests}/${campaign.targetRequests} thành công (Tổng gửi: ${campaign.totalDispatched} reqs).`
    };

    sendLog(campaignId, messages[reason] || `Kết thúc: ${reason}`, reason === 'completed' ? 'success' : 'warn');
    saveCampaignImmediate(campaignId);
    io.emit('status-update', { campaignId, status: campaign.status, isRunning: false });
    emitStats(campaignId);
    emitCampaignList();
}

// ─── HTTP Request Dispatcher ──────────────────────────────────────────────────
async function dispatchRequest(campaignId, isRetry = false, retryAttempt = 0) {
    const campaign = campaigns.get(campaignId);
    if (!campaign || campaign.status !== 'running') return;

    // Chặn tuyệt đối không dispatch nếu số thành công + in-flight đã chạm mốc target!
    if (campaign.successRequests + campaign.activeWorkers >= campaign.targetRequests) {
        return;
    }

    campaign.activeWorkers++;
    campaign.totalDispatched++;
    markCampaignDirty(campaignId);
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

            // Nếu đạt đúng target: Hủy ngay hàng đợi retry để tránh bắn dư bất kỳ request nào!
            if (campaign.successRequests >= campaign.targetRequests) {
                campaign.retryQueue = [];
                campaign.nextScheduledTime = null;
            }
        } else {
            campaign.failedRequests++;
            sendLog(campaignId, `[Lỗi] ${targetUrl}: ${result.error || `HTTP ${result.statusCode}`} (${result.latencyMs}ms)`, 'error', {
                statusCode: result.statusCode,
                error: result.error,
                latencyMs: result.latencyMs
            });

            // Kiểm tra điều kiện retry an toàn:
            // Chỉ retry nếu tổng thành công + in-flight CHƯA chạm target!
            const remainingNeeded = campaign.targetRequests - (campaign.successRequests + campaign.activeWorkers);
            const nextAttempt = retryAttempt + 1;
            const retryAt = Date.now() + (campaign.config.retryBackoffMs || 2000);

            if (remainingNeeded > 0 && nextAttempt <= (campaign.config.maxRetries || 1) && retryAt < campaign.endTime) {
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
        markCampaignDirty(campaignId);
        emitStats(campaignId);

        // Kiểm tra điều kiện hoàn thành
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
                saveCampaignImmediate(campaignId);
                sendLog(campaignId, `Bắt đầu chạy chiến dịch! Mục tiêu: ${campaign.targetRequests} requests thành công.`, 'info');
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

        // 4. Dọn các retry đã quá hạn kết thúc chiến dịch
        campaign.retryQueue = campaign.retryQueue.filter(r => r.dueAt < campaign.endTime);

        // 5. Kiểm tra giới hạn luồng đồng thời (Concurrency)
        const maxConcurrent = campaign.config.maxConcurrent || 3;
        if (campaign.activeWorkers >= maxConcurrent) {
            emitStats(campaignId);
            return;
        }

        // 6. KIỂM TRA QUOTA AN TOÀN CHỐNG VƯỢT TARGET:
        // Tính tổng số request còn thiếu để chạm mốc Target:
        const remainingSlots = campaign.targetRequests - (campaign.successRequests + campaign.activeWorkers);
        if (remainingSlots <= 0) {
            // Số success + in-flight đã đủ để cán đích! Không dispatch thêm bất cứ request hay retry nào!
            campaign.retryQueue = [];
            return;
        }

        // 7. Xử lý retry an toàn (Retry queue)
        const dueRetryIndex = campaign.retryQueue.findIndex(r => r.dueAt <= now);
        if (dueRetryIndex >= 0 && campaign.activeWorkers < maxConcurrent && remainingSlots > 0) {
            const retryJob = campaign.retryQueue.splice(dueRetryIndex, 1)[0];
            dispatchRequest(campaignId, true, retryJob.attempt);
            return;
        }

        // 8. Thuật toán Adaptive Smart/Even Scheduler
        const adaptive = calculateAdaptiveNextInterval({
            now,
            endTime: campaign.endTime,
            remainingRequests: remainingSlots,
            mode: campaign.config.scheduleMode,
            timezoneOffsetMinutes: campaign.config.timezoneOffsetMinutes
        });

        if (!adaptive.valid) return;

        campaign.currentRatePerHour = adaptive.currentRatePerHour;
        campaign.lastScheduledIntervalMs = adaptive.idealIntervalMs;

        // Nếu đã đến lịch bắn request tiếp theo:
        if (campaign.nextScheduledTime === null || now >= campaign.nextScheduledTime) {
            campaign.nextScheduledTime = now + adaptive.jitteredIntervalMs;
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

// Danh sách chiến dịch
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
            totalDispatched: c.totalDispatched,
            remaining,
            progressPercent,
            scheduleMode: c.config.scheduleMode,
            maxConcurrent: c.config.maxConcurrent,
            timeoutMs: c.config.timeoutMs,
            startTime: c.config.startTime,
            endTime: c.config.endTime,
            actualStartTime: c.actualStartTime,
            actualEndTime: c.actualEndTime,
            config: c.config
        });
    }
    res.json({ success: true, data: list });
});

// Tạo chiến dịch mới
app.post('/api/campaigns', (req, res) => {
    try {
        const body = req.body;
        if (!body.targetUrl) {
            return res.status(400).json({ success: false, message: 'targetUrl là bắt buộc' });
        }

        let parsed;
        try {
            parsed = new URL(body.targetUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return res.status(400).json({ success: false, message: 'Chỉ hỗ trợ giao thức http hoặc https' });
            }
        } catch (e) {
            return res.status(400).json({ success: false, message: 'targetUrl không hợp lệ' });
        }

        const id = generateCampaignId();
        const state = createCampaignState(id, body);
        campaigns.set(id, state);
        saveCampaignImmediate(id);

        sendLog(id, `Đã tạo chiến dịch mới: "${state.config.name}" (${state.config.targetRequests} reqs, ${state.config.scheduleMode.toUpperCase()})`, 'info');
        emitCampaignList();
        emitStats(id);

        res.json({ success: true, id, campaign: state.config });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Cập nhật chiến dịch
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
        saveCampaignImmediate(id);

        sendLog(id, `Cập nhật cấu hình chiến dịch thành công`, 'info');
        emitCampaignList();
        emitStats(id);

        res.json({ success: true, campaign: newConfig });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Xóa chiến dịch
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

// Bắt đầu / Tiếp tục chiến dịch
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
    campaign.nextScheduledTime = null; // Re-evaluate ngay lập tức

    saveCampaignImmediate(id);
    sendLog(id, `Khởi động/Tiếp tục chiến dịch`, 'info');
    emitCampaignList();
    emitStats(id);
    res.json({ success: true, status: campaign.status });
});

// Tạm dừng chiến dịch
app.post('/api/campaigns/:id/pause', (req, res) => {
    const id = req.params.id;
    const campaign = campaigns.get(id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Chiến dịch không tồn tại' });

    campaign.status = 'paused';
    saveCampaignImmediate(id);
    sendLog(id, `Tạm dừng chiến dịch`, 'warn');
    emitCampaignList();
    emitStats(id);
    res.json({ success: true, status: 'paused' });
});

// Dừng hẳn chiến dịch
app.post('/api/campaigns/:id/stop', (req, res) => {
    const id = req.params.id;
    completeCampaign(id, 'stopped');
    res.json({ success: true, status: 'stopped' });
});

// Reset tiến trình chiến dịch
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
    campaign.actualEndTime = null;

    const now = Date.now();
    if (now >= campaign.endTime) campaign.status = 'expired';
    else if (now >= campaign.startTime) {
        campaign.status = 'running';
        campaign.actualStartTime = now;
    } else {
        campaign.status = 'waiting';
        campaign.actualStartTime = null;
    }

    saveCampaignImmediate(id);
    sendLog(id, `Đã làm mới (reset) tiến trình chiến dịch`, 'info');
    emitCampaignList();
    emitStats(id);
    res.json({ success: true, status: campaign.status });
});

// API Xem trước phân bổ nhịp
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

// API Test Ping URL kiểm thử kết nối an toàn
app.post('/api/test-url', async (req, res) => {
    const { url, timeoutMs = 5000 } = req.body;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, message: 'URL là bắt buộc và phải là chuỗi' });
    }

    let parsed;
    try {
        parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).json({ success: false, message: 'Chỉ hỗ trợ giao thức http hoặc https' });
        }
    } catch (err) {
        return res.status(400).json({ success: false, message: 'Định dạng URL không hợp lệ' });
    }

    const result = await executeHttpRequest({
        url: parsed.href,
        timeoutMs: Math.min(15000, Math.max(1000, parseInt(timeoutMs, 10) || 5000))
    });
    res.json(result);
});

// ─── Khởi động Server ──────────────────────────────────────────────────────────
loadCampaignsFromDisk();

server.listen(PORT, HOST, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 TRAFFIC BENCHMARK RUNNER 2.0 (SUPER LIGHTWEIGHT)`);
    console.log(`📡 Dashboard đang chạy tại: http://${HOST}:${PORT}`);
    console.log(`🔒 Bảo mật: Chỉ lắng nghe cục bộ trên ${HOST}`);
    console.log(`⚡ Sẵn sàng chạy load test HTTP với Even & Smart Distribution`);
    console.log(`======================================================\n`);
});
