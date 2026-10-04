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

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function formatVnTime(ms = Date.now()) {
    const d = new Date(ms + 7 * 3600000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

// In-memory fallback when neither DO nor KV is attached
let memoryCampaigns = new Map();
let lastCronState = null;

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

// ─── Cloudflare Durable Object: CampaignRunnerDO ─────────────────────────────
// Strongly consistent storage + precision Alarms API for organic Smart/Even pacing

export class CampaignRunnerDO {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.storage = ctx.storage;
    }

    async alarm() {
        try {
            const campaign = await this.storage.get('campaign');
            if (!campaign) {
                await this.storage.deleteAlarm();
                return;
            }

            if (['stopped', 'completed', 'expired', 'paused'].includes(campaign.status)) {
                await this.storage.deleteAlarm();
                return;
            }

            const now = Date.now();

            // Check if waiting for start time
            if (campaign.status === 'waiting') {
                if (now >= campaign.startTime) {
                    campaign.status = 'running';
                    campaign.actualStartTime = now;
                } else {
                    await this.storage.setAlarm(campaign.startTime);
                    return;
                }
            }

            // Check if campaign duration ended
            if (now >= campaign.endTime) {
                campaign.status = (campaign.successRequests || 0) >= campaign.targetRequests ? 'completed' : 'expired';
                campaign.actualEndTime = now;
                await this.storage.put('campaign', campaign);
                await this.storage.deleteAlarm();
                return;
            }

            const remaining = campaign.targetRequests - (campaign.successRequests || 0);
            if (remaining <= 0) {
                campaign.status = 'completed';
                campaign.actualEndTime = now;
                await this.storage.put('campaign', campaign);
                await this.storage.deleteAlarm();
                return;
            }

            // Execute 1 HTTP request with organic Keep-Alive
            const res = await executeWorkerRequest(campaign.targetUrl, campaign.timeoutMs || 8000);
            const reqNow = Date.now();
            const reqViTime = formatVnTime(reqNow);

            campaign.totalDispatched = (campaign.totalDispatched || 0) + 1;
            if (res.success) {
                campaign.successRequests = (campaign.successRequests || 0) + 1;
            } else {
                campaign.failedRequests = (campaign.failedRequests || 0) + 1;
            }

            campaign.lastAlarmRun = reqNow;
            campaign.lastAlarmRunText = reqViTime;
            campaign.lastRequestTime = reqNow;
            campaign.lastRequestText = reqViTime;
            campaign.lastStatusCode = res.statusCode;
            campaign.lastLatencyMs = res.latencyMs;
            campaign.lastError = res.error || null;

            if (!Array.isArray(campaign.recentLogs)) campaign.recentLogs = [];
            campaign.recentLogs.push({
                timestamp: reqViTime,
                statusCode: res.statusCode,
                latencyMs: res.latencyMs,
                success: res.success,
                text: res.success
                    ? `[${res.statusCode} OK] ${campaign.targetUrl} (${res.latencyMs}ms)`
                    : `[Lỗi] ${res.error} (${res.latencyMs}ms)`
            });
            if (campaign.recentLogs.length > 40) campaign.recentLogs.shift();

            // Check if finished right now
            if ((campaign.successRequests || 0) >= campaign.targetRequests) {
                campaign.status = 'completed';
                campaign.actualEndTime = reqNow;
                await this.storage.put('campaign', campaign);
                await this.storage.deleteAlarm();
                return;
            }

            // Calculate next adaptive interval for Smart / Even
            const newRemaining = campaign.targetRequests - (campaign.successRequests || 0);
            const adaptive = calculateAdaptiveNextInterval({
                now: reqNow,
                endTime: campaign.endTime,
                remainingRequests: newRemaining,
                mode: campaign.scheduleMode || 'smart',
                timezoneOffsetMinutes: campaign.timezoneOffsetMinutes
            });

            // Persist strongly consistent state in Durable Object
            await this.storage.put('campaign', campaign);

            // Reschedule alarm for the natural organic interval
            let nextIntervalMs = adaptive.jitteredIntervalMs || 5000;
            // Floor at 1000ms (1s), ceiling at time left before endTime
            nextIntervalMs = Math.max(1000, Math.min(nextIntervalMs, Math.max(1000, campaign.endTime - reqNow)));
            const nextAlarmTime = reqNow + nextIntervalMs;
            await this.storage.setAlarm(nextAlarmTime);
        } catch (err) {
            console.error('[DO Alarm Error]:', err.message);
            try {
                await this.storage.setAlarm(Date.now() + 5000);
            } catch (_) {}
        }
    }

    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;

        // 1. Registry operations (for idFromName('system:registry'))
        if (path === '/registry/get-ids') {
            const ids = await this.storage.get('campaign_ids') || [];
            return new Response(JSON.stringify(ids), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/registry/add-id' && request.method === 'POST') {
            const { id } = await request.json();
            const ids = await this.storage.get('campaign_ids') || [];
            if (!ids.includes(String(id))) {
                ids.push(String(id));
                await this.storage.put('campaign_ids', ids);
            }
            return new Response(JSON.stringify({ success: true, ids }), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/registry/remove-id' && request.method === 'POST') {
            const { id } = await request.json();
            let ids = await this.storage.get('campaign_ids') || [];
            ids = ids.filter(item => String(item) !== String(id));
            await this.storage.put('campaign_ids', ids);
            return new Response(JSON.stringify({ success: true, ids }), { headers: { 'Content-Type': 'application/json' } });
        }

        // 2. Individual Campaign operations
        if (path === '/state' && request.method === 'GET') {
            const campaign = await this.storage.get('campaign');
            const nextAlarm = await this.storage.getAlarm();
            return new Response(JSON.stringify({ campaign, nextAlarm }), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/init' && request.method === 'POST') {
            const data = await request.json();
            await this.storage.put('campaign', data);
            const now = Date.now();
            if (data.status === 'running') {
                await this.storage.setAlarm(now + 150);
            } else if (data.status === 'waiting' && data.startTime > now) {
                await this.storage.setAlarm(data.startTime);
            }
            return new Response(JSON.stringify({ success: true, campaign: data }), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/action' && request.method === 'POST') {
            const { action } = await request.json();
            const campaign = await this.storage.get('campaign');
            if (!campaign) return new Response(JSON.stringify({ success: false, message: 'Chiến dịch không tồn tại' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

            const now = Date.now();
            if (action === 'start') {
                campaign.status = now >= campaign.startTime ? 'running' : 'waiting';
                if (!campaign.actualStartTime && campaign.status === 'running') campaign.actualStartTime = now;
                if (campaign.status === 'running') {
                    await this.storage.setAlarm(now + 150);
                } else {
                    await this.storage.setAlarm(campaign.startTime);
                }
            } else if (action === 'pause') {
                campaign.status = 'paused';
                await this.storage.deleteAlarm();
            } else if (action === 'stop') {
                campaign.status = 'stopped';
                campaign.actualEndTime = now;
                await this.storage.deleteAlarm();
            } else if (action === 'reset') {
                campaign.successRequests = 0;
                campaign.failedRequests = 0;
                campaign.totalDispatched = 0;
                campaign.lastAlarmRun = null;
                campaign.lastAlarmRunText = null;
                campaign.lastRequestTime = null;
                campaign.lastRequestText = null;
                campaign.lastStatusCode = null;
                campaign.lastLatencyMs = null;
                campaign.lastError = null;
                campaign.actualEndTime = null;
                campaign.recentLogs = [];
                campaign.status = now >= campaign.startTime ? 'running' : 'waiting';
                if (campaign.status === 'running') {
                    await this.storage.setAlarm(now + 150);
                } else {
                    await this.storage.setAlarm(campaign.startTime);
                }
            }
            await this.storage.put('campaign', campaign);
            return new Response(JSON.stringify({ success: true, status: campaign.status }), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/update' && request.method === 'PUT') {
            const body = await request.json();
            const campaign = await this.storage.get('campaign');
            if (!campaign) return new Response(JSON.stringify({ success: false, message: 'Chiến dịch không tồn tại' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            Object.assign(campaign, body);
            await this.storage.put('campaign', campaign);
            return new Response(JSON.stringify({ success: true, campaign }), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/delete' && request.method === 'DELETE') {
            await this.storage.deleteAlarm();
            await this.storage.deleteAll();
            return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        }

        return new Response('Not found', { status: 404 });
    }
}

// ─── Durable Object Bridge Helpers ───────────────────────────────────────────

async function getRegistryIds(env) {
    if (env && env.CAMPAIGN_RUNNER) {
        try {
            const regId = env.CAMPAIGN_RUNNER.idFromName('system:registry');
            const stub = env.CAMPAIGN_RUNNER.get(regId);
            const res = await stub.fetch('http://do/registry/get-ids');
            if (res.ok) return await res.json();
        } catch (e) {
            console.error('[DO Registry] Error getting IDs:', e.message);
        }
    }
    return null;
}

async function addRegistryId(env, id) {
    if (env && env.CAMPAIGN_RUNNER) {
        try {
            const regId = env.CAMPAIGN_RUNNER.idFromName('system:registry');
            const stub = env.CAMPAIGN_RUNNER.get(regId);
            await stub.fetch('http://do/registry/add-id', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: String(id) })
            });
        } catch (e) {
            console.error('[DO Registry] Error adding ID:', e.message);
        }
    }
}

async function removeRegistryId(env, id) {
    if (env && env.CAMPAIGN_RUNNER) {
        try {
            const regId = env.CAMPAIGN_RUNNER.idFromName('system:registry');
            const stub = env.CAMPAIGN_RUNNER.get(regId);
            await stub.fetch('http://do/registry/remove-id', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: String(id) })
            });
        } catch (e) {
            console.error('[DO Registry] Error removing ID:', e.message);
        }
    }
}

async function getDODetails(env, id) {
    if (!env || !env.CAMPAIGN_RUNNER) return null;
    try {
        const doId = env.CAMPAIGN_RUNNER.idFromName(String(id));
        const stub = env.CAMPAIGN_RUNNER.get(doId);
        const res = await stub.fetch('http://do/state');
        if (res.ok) {
            const data = await res.json();
            if (data.campaign) {
                return {
                    ...data.campaign,
                    nextAlarm: data.nextAlarm || null
                };
            }
        }
    } catch (e) {
        console.error(`[DO] Error getting campaign ${id}:`, e.message);
    }
    return null;
}

// ─── Storage Helpers (DO first, KV fallback) ──────────────────────────────────

async function getCampaigns(env) {
    if (env && env.CAMPAIGN_RUNNER) {
        try {
            const ids = await getRegistryIds(env);
            if (Array.isArray(ids)) {
                const list = [];
                for (const id of ids) {
                    const c = await getDODetails(env, id);
                    if (c) list.push(c);
                }
                return list;
            }
        } catch (e) {
            console.error('[DO] Error fetching campaigns:', e.message);
        }
    }

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
            console.error('[KV] Error saving campaigns mirror:', e.message);
        }
    } else {
        memoryCampaigns = new Map(campaignsList.map(c => [String(c.id), c]));
    }
}

// ─── Cron Trigger Handler (Health & Watchdog) ─────────────────────────────────

async function handleScheduled(event, env, ctx) {
    const now = Date.now();
    const viTime = formatVnTime(now);

    let totalProcessed = 0;
    let totalDispatchedInRun = 0;

    // If Durable Objects are active: Watchdog revives any stalled alarms
    if (env && env.CAMPAIGN_RUNNER) {
        try {
            const ids = await getRegistryIds(env) || [];
            for (const id of ids) {
                const c = await getDODetails(env, id);
                if (c && c.status === 'running') {
                    totalProcessed++;
                    if (!c.nextAlarm && now < c.endTime && (c.successRequests || 0) < c.targetRequests) {
                        const doId = env.CAMPAIGN_RUNNER.idFromName(String(id));
                        const stub = env.CAMPAIGN_RUNNER.get(doId);
                        await stub.fetch('http://do/action', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'start' })
                        });
                    }
                }
            }
        } catch (e) {
            console.error('[Watchdog DO Error]:', e.message);
        }
    } else {
        // Fallback: Cron batch runner if DO is not configured
        const campaignsList = await getCampaigns(env);
        let changed = false;

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
    }

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

    // GET /api/health - Check Worker, Storage (DO / KV), and Engine Pacing
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
        const isDO = Boolean(env && env.CAMPAIGN_RUNNER);

        let latestReqText = null;
        let latestReqTime = null;
        for (const c of list) {
            if (c.lastRequestTime && (!latestReqTime || c.lastRequestTime > latestReqTime)) {
                latestReqTime = c.lastRequestTime;
                latestReqText = c.lastRequestText;
            }
        }

        return new Response(JSON.stringify({
            worker: 'ok',
            status: 'healthy',
            storage: isDO ? 'durable_objects' : ((env && env.CAMPAIGNS_KV) ? 'connected' : 'memory'),
            storageLabel: isDO ? '🟢 Durable Objects (Strong Consistency)' : '🟡 KV Storage',
            engine: isDO ? 'DO Alarms (Organic Smart Pacing)' : 'Cron Trigger',
            engineType: isDO ? 'durable_objects' : 'cron',
            lastCronRun: cronMeta ? cronMeta.timestamp : null,
            lastCronRunText: cronMeta ? cronMeta.timeText : 'Chưa chạy (Never)',
            cronSecondsAgo: diffSec,
            cronStatus,
            latestRequestText: latestReqText,
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
        const now = Date.now();
        const list = await getCampaigns(env);
        const nextId = String(list.reduce((max, c) => Math.max(max, parseInt(c.id, 10) || 0), 0) + 1);
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
            lastAlarmRun: null,
            lastAlarmRunText: null,
            lastRequestTime: null,
            lastRequestText: null,
            lastStatusCode: null,
            lastLatencyMs: null,
            lastError: null,
            actualStartTime: now,
            actualEndTime: null,
            recentLogs: []
        };

        if (env && env.CAMPAIGN_RUNNER) {
            await addRegistryId(env, nextId);
            const doId = env.CAMPAIGN_RUNNER.idFromName(nextId);
            const stub = env.CAMPAIGN_RUNNER.get(doId);
            await stub.fetch('http://do/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sample)
            });
        } else {
            list.push(sample);
            await saveCampaigns(env, list);
        }

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
                lastAlarmRun: null,
                lastAlarmRunText: null,
                lastRequestTime: null,
                lastRequestText: null,
                lastStatusCode: null,
                lastLatencyMs: null,
                lastError: null,
                actualStartTime: (Number(body.startTime) || Date.now()) <= Date.now() ? Date.now() : null,
                actualEndTime: null,
                recentLogs: []
            };

            if (env && env.CAMPAIGN_RUNNER) {
                await addRegistryId(env, nextId);
                const doId = env.CAMPAIGN_RUNNER.idFromName(nextId);
                const stub = env.CAMPAIGN_RUNNER.get(doId);
                await stub.fetch('http://do/init', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newCampaign)
                });
            } else {
                list.push(newCampaign);
                await saveCampaigns(env, list);
            }

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

        if (env && env.CAMPAIGN_RUNNER) {
            if (request.method === 'DELETE') {
                await removeRegistryId(env, id);
                const doId = env.CAMPAIGN_RUNNER.idFromName(id);
                const stub = env.CAMPAIGN_RUNNER.get(doId);
                await stub.fetch('http://do/delete', { method: 'DELETE' });
                return new Response(JSON.stringify({ success: true, message: `Đã xóa chiến dịch ${id}` }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }

            if (request.method === 'PUT') {
                const body = await request.json();
                const doId = env.CAMPAIGN_RUNNER.idFromName(id);
                const stub = env.CAMPAIGN_RUNNER.get(doId);
                const res = await stub.fetch('http://do/update', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const d = await res.json();
                return new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }

            if (request.method === 'POST') {
                const doId = env.CAMPAIGN_RUNNER.idFromName(id);
                const stub = env.CAMPAIGN_RUNNER.get(doId);
                const res = await stub.fetch('http://do/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action })
                });
                const d = await res.json();
                return new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }
        }

        // Fallback (KV / Memory)
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

