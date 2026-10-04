/**
 * worker.js - Cloudflare Worker Entrypoint (ES Module)
 * Supports:
 *  - REST API & Static Asset Serving (Dashboard)
 *  - Cloudflare Cron Trigger (Runs every 1 min for 24/7 background load testing)
 *  - Cloudflare KV Persistence (CAMPAIGNS_KV)
 *  - Adaptive Smart/Even Scheduler Pacing
 */

// ─── Time Distribution Engine (Inlined) ──────────────────────────────────────

const SMART_HOURLY_WEIGHTS = {
    0: 0.25, 1: 0.15, 2: 0.10, 3: 0.10, 4: 0.15, 5: 0.30,
    6: 0.60, 7: 0.90, 8: 1.20,
    9: 1.60, 10: 1.70, 11: 1.50,
    12: 1.00, 13: 1.10,
    14: 1.60, 15: 1.80, 16: 1.70, 17: 1.50,
    18: 1.40, 19: 1.60, 20: 1.70, 21: 1.50,
    22: 1.00, 23: 0.60
};

const TIME_BLOCK_DEFINITIONS = [
    { id: 'night', label: '🌙 Đêm (00h-06h)', hours: [0,1,2,3,4,5], color: '#64748b' },
    { id: 'early', label: '🌅 Sáng sớm (06h-09h)', hours: [6,7,8], color: '#f59e0b' },
    { id: 'morn',  label: '💼 Sáng cao điểm (09h-12h)', hours: [9,10,11], color: '#22c55e' },
    { id: 'noon',  label: '🍱 Trưa (12h-14h)', hours: [12,13], color: '#38bdf8' },
    { id: 'after', label: '📈 Chiều cao điểm (14h-18h)', hours: [14,15,16,17], color: '#818cf8' },
    { id: 'eve',   label: '📱 Tối cao điểm (18h-22h)', hours: [18,19,20,21], color: '#ec4899' },
    { id: 'late',  label: '🌜 Khuya (22h-00h)', hours: [22,23], color: '#a855f7' }
];

function hasTimezoneOffset(tz) {
    return tz !== null && tz !== undefined && tz !== '' && Number.isFinite(Number(tz));
}

function formatDuration(durationMs) {
    if (durationMs <= 0) return '0 giây';
    const totalSecs = Math.round(durationMs / 1000);
    const totalMins = Math.floor(totalSecs / 60);
    const secsRemaining = totalSecs % 60;
    if (totalSecs < 60) return `${totalSecs} giây`;
    if (totalMins < 60) return secsRemaining > 0 ? `${totalMins} phút ${secsRemaining}s` : `${totalMins} phút`;
    const totalHours = Math.floor(totalMins / 60);
    const minsRemaining = totalMins % 60;
    if (totalHours < 24) return minsRemaining > 0 ? `${totalHours} giờ ${minsRemaining} phút` : `${totalHours} giờ`;
    const totalDays = Math.floor(totalHours / 24);
    const hoursRemaining = totalHours % 24;
    return `${totalDays} ngày ${hoursRemaining > 0 ? hoursRemaining + ' giờ ' : ''}${minsRemaining > 0 ? minsRemaining + ' phút' : ''}`.trim();
}

function toOffsetDate(ms, timezoneOffsetMinutes = null) {
    if (!hasTimezoneOffset(timezoneOffsetMinutes)) return new Date(ms);
    return new Date(ms - Number(timezoneOffsetMinutes) * 60000);
}

function getHourForTimezone(ms, timezoneOffsetMinutes = null) {
    const d = toOffsetDate(ms, timezoneOffsetMinutes);
    return hasTimezoneOffset(timezoneOffsetMinutes) ? d.getUTCHours() : d.getHours();
}

function nextHourForTimezone(ms, timezoneOffsetMinutes = null) {
    if (!hasTimezoneOffset(timezoneOffsetMinutes)) {
        const d = new Date(ms);
        d.setMinutes(0, 0, 0);
        d.setHours(d.getHours() + 1);
        return d.getTime();
    }
    const offset = Number(timezoneOffsetMinutes);
    const local = new Date(ms - offset * 60000);
    const nextLocalUtc = Date.UTC(
        local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
        local.getUTCHours() + 1, 0, 0, 0
    );
    return nextLocalUtc + offset * 60000;
}

function formatTimeOnly(ms, timezoneOffsetMinutes = null) {
    const d = toOffsetDate(ms, timezoneOffsetMinutes);
    const hh = String(hasTimezoneOffset(timezoneOffsetMinutes) ? d.getUTCHours() : d.getHours()).padStart(2, '0');
    const mm = String(hasTimezoneOffset(timezoneOffsetMinutes) ? d.getUTCMinutes() : d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

function buildTimeDistribution({ startTime, endTime, targetClicks, mode = 'smart', timezoneOffsetMinutes = null }) {
    const startMs = typeof startTime === 'number' ? startTime : new Date(startTime).getTime();
    const endMs   = typeof endTime   === 'number' ? endTime   : new Date(endTime).getTime();
    const requests = parseInt(targetClicks, 10) || 0;

    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs || requests <= 0)
        return { valid: false, startMs, endMs, targetClicks: requests, durationMs: 0, durationFormatted: '0 phút', slices: [], summaryBlocks: [], avgIntervalSec: 0 };

    const durationMs = endMs - startMs;
    const durationFormatted = formatDuration(durationMs);
    const avgIntervalSec = Number((durationMs / 1000 / requests).toFixed(1));

    let hourlyWeightMap = SMART_HOURLY_WEIGHTS;
    if (mode === 'even') { hourlyWeightMap = {}; for (let h = 0; h < 24; h++) hourlyWeightMap[h] = 1.0; }

    const rawSlices = [];
    let curTime = startMs;
    while (curTime < endMs) {
        const nextHourTime = nextHourForTimezone(curTime, timezoneOffsetMinutes);
        const sliceEnd = Math.min(endMs, nextHourTime);
        const sliceDurationMs = sliceEnd - curTime;
        const hourOfDay = getHourForTimezone(curTime, timezoneOffsetMinutes);
        const baseWeight = hourlyWeightMap[hourOfDay] !== undefined ? hourlyWeightMap[hourOfDay] : 1.0;
        rawSlices.push({
            start: curTime, end: sliceEnd,
            startStr: formatTimeOnly(curTime, timezoneOffsetMinutes),
            endStr: formatTimeOnly(sliceEnd, timezoneOffsetMinutes),
            durationMs: sliceDurationMs, durationMinutes: Number((sliceDurationMs / 60000).toFixed(1)),
            hourOfDay, weight: baseWeight * (sliceDurationMs / 3600000)
        });
        curTime = sliceEnd;
    }

    const totalWeight = rawSlices.reduce((sum, s) => sum + s.weight, 0);
    if (totalWeight <= 0) return { valid: false, startMs, endMs, targetClicks: requests, durationMs, durationFormatted, slices: [], summaryBlocks: [], avgIntervalSec };

    let totalAllocated = 0;
    const slicesWithQuota = rawSlices.map((s, index) => {
        const exact = requests * (s.weight / totalWeight);
        const quota = Math.floor(exact);
        totalAllocated += quota;
        return { ...s, index, quota, remainder: exact - quota };
    });

    let remainderRequests = requests - totalAllocated;
    const sortedByRemainder = [...slicesWithQuota].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < sortedByRemainder.length && remainderRequests > 0; i++) {
        slicesWithQuota[sortedByRemainder[i].index].quota += 1;
        remainderRequests--;
    }

    const slices = slicesWithQuota.map(s => ({ ...s, percent: requests > 0 ? Number(((s.quota / requests) * 100).toFixed(1)) : 0 }));

    let summaryBlocks = [];
    if (durationMs <= 60 * 60 * 1000) {
        summaryBlocks = [{ id: 'exact_span', label: `⏱️ ${slices[0].startStr} → ${slices[slices.length - 1].endStr} (${durationFormatted})`, quota: requests, percent: 100, color: '#818cf8', durationFormatted }];
    } else {
        for (const bDef of TIME_BLOCK_DEFINITIONS) {
            const matching = slices.filter(s => bDef.hours.includes(s.hourOfDay));
            if (matching.length === 0) continue;
            const blockQuota = matching.reduce((sum, s) => sum + s.quota, 0);
            summaryBlocks.push({ id: bDef.id, label: bDef.label, quota: blockQuota, percent: Number(((blockQuota / requests) * 100).toFixed(1)), color: bDef.color, durationFormatted: formatDuration(matching.reduce((sum, s) => sum + s.durationMs, 0)) });
        }
    }

    return { valid: true, startMs, endMs, targetClicks: requests, mode, timezoneOffsetMinutes: hasTimezoneOffset(timezoneOffsetMinutes) ? Number(timezoneOffsetMinutes) : null, durationMs, durationFormatted, avgIntervalSec, slices, summaryBlocks };
}

function calculateAdaptiveNextInterval({ now = Date.now(), endTime, remainingRequests, mode = 'smart', timezoneOffsetMinutes = null }) {
    const timeRemainingMs = endTime - now;
    if (timeRemainingMs <= 0 || remainingRequests <= 0)
        return { valid: false, timeRemainingMs: Math.max(0, timeRemainingMs), remainingRequests: Math.max(0, remainingRequests), idealIntervalMs: 0, jitteredIntervalMs: 0, currentRatePerHour: 0 };

    if (mode === 'even') {
        const idealIntervalMs = timeRemainingMs / remainingRequests;
        const jitter = 0.92 + 0.16 * Math.random();
        return { valid: true, timeRemainingMs, remainingRequests, idealIntervalMs: Math.round(idealIntervalMs), jitteredIntervalMs: Math.max(50, Math.round(idealIntervalMs * jitter)), currentRatePerHour: Number(((3600000 / idealIntervalMs)).toFixed(1)), quotaCurrentSlice: Math.max(1, Math.round(remainingRequests * (Math.min(3600000, timeRemainingMs) / timeRemainingMs))) };
    }

    const remainingSlices = [];
    let cur = now;
    while (cur < endTime) {
        const nextHour = nextHourForTimezone(cur, timezoneOffsetMinutes);
        const sliceEnd = Math.min(endTime, nextHour);
        const sliceDur = sliceEnd - cur;
        const hour = getHourForTimezone(cur, timezoneOffsetMinutes);
        const baseW = SMART_HOURLY_WEIGHTS[hour] !== undefined ? SMART_HOURLY_WEIGHTS[hour] : 1.0;
        remainingSlices.push({ start: cur, end: sliceEnd, durationMs: sliceDur, hour, baseW, weight: baseW * (sliceDur / 3600000) });
        cur = sliceEnd;
    }

    const totalRemainingWeight = remainingSlices.reduce((sum, s) => sum + s.weight, 0);
    if (totalRemainingWeight <= 0 || remainingSlices.length === 0) {
        const fallbackInterval = timeRemainingMs / remainingRequests;
        return { valid: true, timeRemainingMs, remainingRequests, idealIntervalMs: Math.round(fallbackInterval), jitteredIntervalMs: Math.round(fallbackInterval * (0.92 + 0.16 * Math.random())), currentRatePerHour: Number(((3600000 / fallbackInterval)).toFixed(1)), quotaCurrentSlice: remainingRequests };
    }

    const currentSlice = remainingSlices[0];
    const currentSliceFraction = currentSlice.weight / totalRemainingWeight;
    const currentSliceQuota = remainingRequests * currentSliceFraction;
    let idealIntervalMs = currentSliceQuota >= 1 ? currentSlice.durationMs / currentSliceQuota : currentSlice.durationMs / Math.max(currentSliceQuota, 0.05);
    idealIntervalMs = Math.min(timeRemainingMs, Math.max(50, idealIntervalMs));
    const jitter = 0.92 + 0.16 * Math.random();
    const jitteredIntervalMs = Math.max(50, Math.round(idealIntervalMs * jitter));
    const currentRatePerHour = Number(((3600000 / idealIntervalMs)).toFixed(1));

    return { valid: true, timeRemainingMs, remainingRequests, idealIntervalMs: Math.round(idealIntervalMs), jitteredIntervalMs, quotaCurrentSlice: Number(currentSliceQuota.toFixed(2)), currentRatePerHour, currentHour: currentSlice.hour, currentHourWeight: currentSlice.baseW };
}

// ─── State & Storage Helpers ──────────────────────────────────────────────────

function formatVnTime(ms = Date.now()) {
    const d = new Date(ms + 7 * 3600000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

// In-memory fallback when KV binding is not attached (pure empty map, no hardcoded sample)
let memoryCampaigns = new Map();
let lastCronState = null;

async function getCampaigns(env) {
    if (env && env.CAMPAIGNS_KV) {
        try {
            const list = await env.CAMPAIGNS_KV.get('campaigns_list', 'json');
            if (Array.isArray(list)) return list;
            return [];
        } catch (e) {
            console.error('[KV] Error reading campaigns:', e.message);
            return [];
        }
    }
    return Array.from(memoryCampaigns.values());
}

async function saveCampaigns(env, campaignsList) {
    if (env && env.CAMPAIGNS_KV) {
        try {
            await env.CAMPAIGNS_KV.put('campaigns_list', JSON.stringify(campaignsList));
        } catch (e) {
            console.error('[KV] Error saving campaigns:', e.message);
        }
    } else {
        memoryCampaigns = new Map(campaignsList.map(c => [String(c.id), c]));
    }
}

// ─── HTTP Subrequest Runner ───────────────────────────────────────────────────

async function executeWorkerRequest(url, timeoutMs = 8000) {
    const startTime = Date.now();
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Connection': 'keep-alive'
            },
            signal: controller.signal
        });
        clearTimeout(timer);
        await response.text();
        const latencyMs = Date.now() - startTime;
        const success = response.status >= 200 && response.status < 400;
        return { success, statusCode: response.status, latencyMs, error: success ? null : `HTTP ${response.status}` };
    } catch (err) {
        const latencyMs = Date.now() - startTime;
        return { success: false, statusCode: null, latencyMs, error: err.name === 'AbortError' ? `Timeout (${timeoutMs}ms)` : err.message };
    }
}

// ─── Cron Trigger Handler ─────────────────────────────────────────────────────

async function handleScheduled(event, env, ctx) {
    const now = Date.now();
    const viTime = formatVnTime(now);
    const campaignsList = await getCampaigns(env);
    let changed = false;
    let totalProcessed = 0;
    let totalDispatchedInRun = 0;

    for (const c of campaignsList) {
        if (['stopped', 'completed', 'expired', 'paused'].includes(c.status)) continue;

        if (c.status === 'waiting') {
            if (now >= c.startTime) {
                c.status = 'running';
                c.actualStartTime = now;
                changed = true;
            } else {
                continue;
            }
        }

        if (now >= c.endTime) {
            c.status = (c.successRequests || 0) >= c.targetRequests ? 'completed' : 'expired';
            c.actualEndTime = now;
            changed = true;
            continue;
        }

        const remaining = c.targetRequests - (c.successRequests || 0);
        if (remaining <= 0) {
            c.status = 'completed';
            c.actualEndTime = now;
            changed = true;
            continue;
        }

        const adaptive = calculateAdaptiveNextInterval({
            now,
            endTime: c.endTime,
            remainingRequests: remaining,
            mode: c.scheduleMode || 'smart',
            timezoneOffsetMinutes: c.timezoneOffsetMinutes
        });
        if (!adaptive.valid) continue;

        const targetRatePerMinute = adaptive.currentRatePerHour / 60;
        let minuteQuota = Math.round(targetRatePerMinute);
        if (targetRatePerMinute > 0 && minuteQuota === 0) minuteQuota = 1;
        minuteQuota = Math.min(remaining, Math.max(1, minuteQuota));
        const maxBatch = Math.min(minuteQuota, c.maxConcurrent || 3, 5);

        totalProcessed++;

        for (let i = 0; i < maxBatch; i++) {
            if ((c.successRequests || 0) >= c.targetRequests) break;

            const res = await executeWorkerRequest(c.targetUrl, c.timeoutMs || 8000);
            const reqNow = Date.now();
            const reqViTime = formatVnTime(reqNow);

            c.totalDispatched = (c.totalDispatched || 0) + 1;
            totalDispatchedInRun++;

            if (res.success) {
                c.successRequests = (c.successRequests || 0) + 1;
            } else {
                c.failedRequests = (c.failedRequests || 0) + 1;
            }

            c.lastCronRun = now;
            c.lastCronRunText = viTime;
            c.lastRequestTime = reqNow;
            c.lastRequestText = reqViTime;
            c.lastStatusCode = res.statusCode;
            c.lastLatencyMs = res.latencyMs;
            c.lastError = res.error || null;

            if (!Array.isArray(c.recentLogs)) c.recentLogs = [];
            c.recentLogs.push({
                timestamp: reqViTime,
                statusCode: res.statusCode,
                latencyMs: res.latencyMs,
                success: res.success,
                text: res.success
                    ? `[${res.statusCode} OK] ${c.targetUrl} (${res.latencyMs}ms)`
                    : `[Lỗi] ${res.error} (${res.latencyMs}ms)`
            });
            if (c.recentLogs.length > 30) c.recentLogs.shift();
            changed = true;
        }

        if ((c.successRequests || 0) >= c.targetRequests) {
            c.status = 'completed';
            c.actualEndTime = now;
            changed = true;
        }
    }

    if (changed) {
        await saveCampaigns(env, campaignsList);
    }

    // Save Cron metadata to KV for live health check
    const cronMeta = {
        timestamp: now,
        timeText: viTime,
        status: 'ok',
        campaignsProcessed: totalProcessed,
        requestsDispatched: totalDispatchedInRun
    };
    lastCronState = cronMeta;

    if (env && env.CAMPAIGNS_KV) {
        try {
            await env.CAMPAIGNS_KV.put('system:last_cron', JSON.stringify(cronMeta));
        } catch (_) {}
    }
}

// ─── Fetch Handler (API + Static Assets) ─────────────────────────────────────

async function handleFetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // GET /api/health - Check Worker, Cron status, Storage & Scheduler
    if (url.pathname === '/api/health' && request.method === 'GET') {
        let cronMeta = lastCronState;
        if (env && env.CAMPAIGNS_KV) {
            try {
                const stored = await env.CAMPAIGNS_KV.get('system:last_cron', 'json');
                if (stored) cronMeta = stored;
            } catch (_) {}
        }

        const now = Date.now();
        const diffSec = (cronMeta && cronMeta.timestamp) ? Math.round((now - cronMeta.timestamp) / 1000) : null;
        let cronStatus = 'never';
        if (diffSec !== null) {
            if (diffSec <= 150) cronStatus = 'active';
            else cronStatus = 'delayed';
        }

        const list = await getCampaigns(env);
        const runningCampaigns = list.filter(c => c.status === 'running').length;

        return new Response(JSON.stringify({
            worker: 'ok',
            status: 'healthy',
            storage: (env && env.CAMPAIGNS_KV) ? 'connected' : 'memory',
            lastCronRun: cronMeta ? cronMeta.timestamp : null,
            lastCronRunText: cronMeta ? cronMeta.timeText : 'Chưa chạy (Never)',
            cronSecondsAgo: diffSec,
            cronStatus,
            totalCampaigns: list.length,
            runningCampaigns,
            serverTime: now,
            serverTimeText: formatVnTime(now)
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // GET /api/campaigns
    if (url.pathname === '/api/campaigns' && request.method === 'GET') {
        const list = await getCampaigns(env);
        const enriched = list.map(c => {
            const remaining = Math.max(0, c.targetRequests - (c.successRequests || 0));
            const progressPercent = c.targetRequests > 0 ? Number((((c.successRequests || 0) / c.targetRequests) * 100).toFixed(1)) : 0;
            return { ...c, remaining, progressPercent, config: { ...c } };
        });
        return new Response(JSON.stringify({ success: true, data: enriched }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // POST /api/campaigns/sample (Tạo chiến dịch mẫu chạy ngay hôm nay)
    if (url.pathname === '/api/campaigns/sample' && request.method === 'POST') {
        const list = await getCampaigns(env);
        const nextId = String(list.reduce((max, c) => Math.max(max, parseInt(c.id, 10) || 0), 0) + 1);
        const now = Date.now();
        const sample = {
            id: nextId,
            name: `Chiến dịch Mẫu ${nextId} (${formatVnTime(now)})`,
            targetUrl: 'https://uanbidvak.com',
            targetRequests: 200,
            startTime: now,
            endTime: now + 2 * 3600000,
            scheduleMode: 'smart',
            timeoutMs: 8000,
            maxConcurrent: 3,
            timezoneOffsetMinutes: -420,
            maxRetries: 1,
            status: 'running',
            successRequests: 0,
            failedRequests: 0,
            totalDispatched: 0,
            lastCronRun: null,
            lastCronRunText: null,
            lastRequestTime: null,
            lastRequestText: null,
            lastStatusCode: null,
            lastLatencyMs: null,
            lastError: null,
            actualStartTime: now,
            actualEndTime: null,
            recentLogs: []
        };
        list.push(sample);
        await saveCampaigns(env, list);
        return new Response(JSON.stringify({ success: true, id: nextId, campaign: sample }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // POST /api/campaigns
    if (url.pathname === '/api/campaigns' && request.method === 'POST') {
        try {
            const body = await request.json();
            if (!body.targetUrl) return new Response(JSON.stringify({ success: false, message: 'targetUrl là bắt buộc' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

            const list = await getCampaigns(env);
            const nextId = String(list.reduce((max, c) => Math.max(max, parseInt(c.id, 10) || 0), 0) + 1);
            const newCampaign = {
                id: nextId,
                name: body.name || `Chiến dịch ${nextId}`,
                targetUrl: body.targetUrl,
                targetRequests: parseInt(body.targetRequests, 10) || 100,
                startTime: Number(body.startTime) || Date.now(),
                endTime: Number(body.endTime) || (Date.now() + 6 * 3600000),
                scheduleMode: body.scheduleMode === 'even' ? 'even' : 'smart',
                timeoutMs: parseInt(body.timeoutMs, 10) || 8000,
                maxConcurrent: Math.max(1, Math.min(20, parseInt(body.maxConcurrent, 10) || 3)),
                timezoneOffsetMinutes: hasTimezoneOffset(body.timezoneOffsetMinutes) ? Number(body.timezoneOffsetMinutes) : -420,
                maxRetries: 1,
                status: (Number(body.startTime) || Date.now()) <= Date.now() ? 'running' : 'waiting',
                successRequests: 0,
                failedRequests: 0,
                totalDispatched: 0,
                lastCronRun: null,
                lastCronRunText: null,
                lastRequestTime: null,
                lastRequestText: null,
                lastStatusCode: null,
                lastLatencyMs: null,
                lastError: null,
                actualStartTime: Date.now(),
                actualEndTime: null,
                recentLogs: []
            };
            list.push(newCampaign);
            await saveCampaigns(env, list);
            return new Response(JSON.stringify({ success: true, id: nextId, campaign: newCampaign }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
            return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
    }

    // /api/campaigns/:id or /api/campaigns/:id/action
    const campaignActionMatch = url.pathname.match(/^\/api\/campaigns\/(\w+)(\/(\w+))?$/);
    if (campaignActionMatch) {
        const id = campaignActionMatch[1];
        const action = campaignActionMatch[3];
        const list = await getCampaigns(env);
        const index = list.findIndex(c => String(c.id) === id);
        if (index === -1) return new Response(JSON.stringify({ success: false, message: 'Chiến dịch không tồn tại' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        const campaign = list[index];

        if (request.method === 'DELETE') {
            list.splice(index, 1);
            await saveCampaigns(env, list);
            return new Response(JSON.stringify({ success: true, message: `Đã xóa chiến dịch ${id}` }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        if (request.method === 'PUT') {
            const body = await request.json();
            Object.assign(campaign, body);
            await saveCampaigns(env, list);
            return new Response(JSON.stringify({ success: true, campaign }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        if (request.method === 'POST') {
            if (action === 'start') {
                campaign.status = Date.now() >= campaign.startTime ? 'running' : 'waiting';
                if (!campaign.actualStartTime && campaign.status === 'running') campaign.actualStartTime = Date.now();
            } else if (action === 'pause') {
                campaign.status = 'paused';
            } else if (action === 'stop') {
                campaign.status = 'stopped';
                campaign.actualEndTime = Date.now();
            } else if (action === 'reset') {
                campaign.successRequests = 0;
                campaign.failedRequests = 0;
                campaign.totalDispatched = 0;
                campaign.lastCronRun = null;
                campaign.lastCronRunText = null;
                campaign.lastRequestTime = null;
                campaign.lastRequestText = null;
                campaign.lastStatusCode = null;
                campaign.lastLatencyMs = null;
                campaign.lastError = null;
                campaign.actualEndTime = null;
                campaign.recentLogs = [];
                campaign.status = Date.now() >= campaign.startTime ? 'running' : 'waiting';
            }
            await saveCampaigns(env, list);
            return new Response(JSON.stringify({ success: true, status: campaign.status }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
    }

    // POST /api/test-url
    if (url.pathname === '/api/test-url' && request.method === 'POST') {
        const body = await request.json();
        const result = await executeWorkerRequest(body.url, parseInt(body.timeoutMs, 10) || 5000);
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // GET /api/preview-distribution
    if (url.pathname === '/api/preview-distribution') {
        const start = Number(url.searchParams.get('startTime'));
        const end   = Number(url.searchParams.get('endTime'));
        const count = parseInt(url.searchParams.get('targetRequests'), 10) || 100;
        const mode  = url.searchParams.get('mode') || 'smart';
        const tz    = url.searchParams.get('timezoneOffsetMinutes');
        const dist  = buildTimeDistribution({ startTime: start, endTime: end, targetClicks: count, mode, timezoneOffsetMinutes: hasTimezoneOffset(tz) ? Number(tz) : -420 });
        return new Response(JSON.stringify({ success: true, data: dist }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // Static assets (dashboard)
    if (env && env.ASSETS) return env.ASSETS.fetch(request);

    return new Response('Traffic Benchmark Runner - Cloudflare Worker', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ─── ES Module Exports ────────────────────────────────────────────────────────

export default {
    fetch: handleFetch,
    scheduled: handleScheduled
};
