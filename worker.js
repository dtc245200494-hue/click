/**
 * worker.js - Cloudflare Worker Entrypoint
 * Supports:
 *  - REST API & Static Asset Serving (Dashboard)
 *  - Cloudflare Cron Trigger (Runs every 1 min for 24/7 background load testing)
 *  - Cloudflare KV Persistence (CAMPAIGNS_KV)
 *  - Adaptive Smart/Even Scheduler Pacing
 */

const {
    calculateAdaptiveNextInterval,
    buildTimeDistribution,
    formatDuration,
    hasTimezoneOffset
} = require('./timeDistribution');

// Default initial campaign if KV is empty
const DEFAULT_CAMPAIGN = {
    id: "1",
    name: "Chiến dịch Benchmark 1",
    targetUrl: "https://uanbidvak.com",
    targetRequests: 900,
    startTime: 1790212260000,
    endTime: 1790262000000,
    scheduleMode: "smart",
    timeoutMs: 8000,
    maxConcurrent: 3,
    timezoneOffsetMinutes: -420,
    maxRetries: 1,
    status: "waiting",
    successRequests: 0,
    failedRequests: 0,
    totalDispatched: 0,
    actualStartTime: null,
    actualEndTime: null,
    recentLogs: []
};

// In-memory fallback if KV binding is not yet attached
let memoryCampaigns = new Map([["1", { ...DEFAULT_CAMPAIGN }]]);

// ─── Storage Helpers ───────────────────────────────────────────────────────────
async function getCampaigns(env) {
    if (env && env.CAMPAIGNS_KV) {
        try {
            const list = await env.CAMPAIGNS_KV.get('campaigns_list', 'json');
            if (Array.isArray(list) && list.length > 0) return list;
            // Initialize default if empty
            await env.CAMPAIGNS_KV.put('campaigns_list', JSON.stringify([DEFAULT_CAMPAIGN]));
            return [DEFAULT_CAMPAIGN];
        } catch (e) {
            console.error('[KV] Error reading campaigns:', e.message);
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

// ─── HTTP Subrequest Runner ────────────────────────────────────────────────────
async function executeWorkerRequest(url, timeoutMs = 8000) {
    const startTime = Date.now();
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 CloudflareWorkerTester/2.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Connection': 'keep-alive'
            },
            signal: controller.signal
        });

        clearTimeout(timer);
        // Consume response body to close stream cleanly
        await response.text();

        const latencyMs = Date.now() - startTime;
        const success = response.status >= 200 && response.status < 400;

        return {
            success,
            statusCode: response.status,
            latencyMs,
            error: success ? null : `HTTP ${response.status}`
        };
    } catch (err) {
        const latencyMs = Date.now() - startTime;
        return {
            success: false,
            statusCode: null,
            latencyMs,
            error: err.name === 'AbortError' ? `Timeout (${timeoutMs}ms)` : err.message
        };
    }
}

// ─── Cron Trigger Handler (Scheduled Event) ───────────────────────────────────
async function handleScheduled(event, env, ctx) {
    const now = Date.now();
    const campaignsList = await getCampaigns(env);
    let changed = false;

    for (const c of campaignsList) {
        if (['stopped', 'completed', 'expired', 'paused'].includes(c.status)) continue;

        // Waiting check
        if (c.status === 'waiting') {
            if (now >= c.startTime) {
                c.status = 'running';
                c.actualStartTime = now;
                changed = true;
            } else {
                continue;
            }
        }

        // Expire check
        if (now >= c.endTime) {
            c.status = c.successRequests >= c.targetRequests ? 'completed' : 'expired';
            c.actualEndTime = now;
            changed = true;
            continue;
        }

        // Target reached check
        const remaining = c.targetRequests - (c.successRequests || 0);
        if (remaining <= 0) {
            c.status = 'completed';
            c.actualEndTime = now;
            changed = true;
            continue;
        }

        // Adaptive calculation for this minute
        const adaptive = calculateAdaptiveNextInterval({
            now,
            endTime: c.endTime,
            remainingRequests: remaining,
            mode: c.scheduleMode || 'smart',
            timezoneOffsetMinutes: c.timezoneOffsetMinutes
        });

        if (!adaptive.valid) continue;

        // Quota for this 1 minute window:
        // If rate is 120 req/h => 2 requests in this minute
        const targetRatePerMinute = adaptive.currentRatePerHour / 60;
        let minuteQuota = Math.round(targetRatePerMinute);
        if (targetRatePerMinute > 0 && minuteQuota === 0) minuteQuota = 1; // At least 1 if due
        minuteQuota = Math.min(remaining, Math.max(1, minuteQuota));

        // Limit concurrent dispatches per cron execution to keep CPU & duration bounded
        const maxBatch = Math.min(minuteQuota, c.maxConcurrent || 3, 5);

        for (let i = 0; i < maxBatch; i++) {
            if (c.successRequests >= c.targetRequests) break;

            const res = await executeWorkerRequest(c.targetUrl, c.timeoutMs || 8000);
            c.totalDispatched = (c.totalDispatched || 0) + 1;

            if (res.success) {
                c.successRequests = (c.successRequests || 0) + 1;
            } else {
                c.failedRequests = (c.failedRequests || 0) + 1;
            }

            // Append log
            if (!Array.isArray(c.recentLogs)) c.recentLogs = [];
            c.recentLogs.push({
                timestamp: new Date().toLocaleTimeString('vi-VN'),
                statusCode: res.statusCode,
                latencyMs: res.latencyMs,
                success: res.success,
                text: res.success ? `[200 OK] ${c.targetUrl} (${res.latencyMs}ms)` : `[Lỗi] ${res.error} (${res.latencyMs}ms)`
            });
            if (c.recentLogs.length > 30) c.recentLogs.shift();

            changed = true;
        }

        if (c.successRequests >= c.targetRequests) {
            c.status = 'completed';
            c.actualEndTime = now;
            changed = true;
        }
    }

    if (changed) {
        await saveCampaigns(env, campaignsList);
    }
}

// ─── Fetch Request Handler (API + Static Assets) ──────────────────────────────
async function handleFetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Headers helper
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // ─── API Routes ───────────────────────────────────────────────────────────
    if (url.pathname === '/api/campaigns') {
        if (request.method === 'GET') {
            const list = await getCampaigns(env);
            const enriched = list.map(c => {
                const remaining = Math.max(0, c.targetRequests - (c.successRequests || 0));
                const progressPercent = c.targetRequests > 0 ? Number((((c.successRequests || 0) / c.targetRequests) * 100).toFixed(1)) : 0;
                return {
                    ...c,
                    remaining,
                    progressPercent,
                    config: { ...c }
                };
            });
            return new Response(JSON.stringify({ success: true, data: enriched }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        if (request.method === 'POST') {
            try {
                const body = await request.json();
                if (!body.targetUrl) {
                    return new Response(JSON.stringify({ success: false, message: 'targetUrl là bắt buộc' }), {
                        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
                    });
                }

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
                    actualStartTime: Date.now(),
                    actualEndTime: null,
                    recentLogs: []
                };

                list.push(newCampaign);
                await saveCampaigns(env, list);

                return new Response(JSON.stringify({ success: true, id: nextId, campaign: newCampaign }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            } catch (e) {
                return new Response(JSON.stringify({ success: false, message: e.message }), {
                    status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            }
        }
    }

    // Specific Campaign Actions: /api/campaigns/:id/...
    const campaignActionMatch = url.pathname.match(/^\/api\/campaigns\/(\w+)(\/(\w+))?$/);
    if (campaignActionMatch) {
        const id = campaignActionMatch[1];
        const action = campaignActionMatch[3]; // start, pause, stop, reset
        const list = await getCampaigns(env);
        const index = list.findIndex(c => String(c.id) === id);

        if (index === -1) {
            return new Response(JSON.stringify({ success: false, message: 'Chiến dịch không tồn tại' }), {
                status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        const campaign = list[index];

        if (request.method === 'DELETE') {
            list.splice(index, 1);
            await saveCampaigns(env, list);
            return new Response(JSON.stringify({ success: true, message: `Đã xóa chiến dịch ${id}` }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        if (request.method === 'PUT') {
            const body = await request.json();
            Object.assign(campaign, body);
            await saveCampaigns(env, list);
            return new Response(JSON.stringify({ success: true, campaign }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
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
                campaign.actualEndTime = null;
                campaign.status = Date.now() >= campaign.startTime ? 'running' : 'waiting';
            }
            await saveCampaigns(env, list);
            return new Response(JSON.stringify({ success: true, status: campaign.status }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }
    }

    // Test ping URL
    if (url.pathname === '/api/test-url' && request.method === 'POST') {
        const body = await request.json();
        const result = await executeWorkerRequest(body.url, parseInt(body.timeoutMs, 10) || 5000);
        return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }

    // Distribution preview
    if (url.pathname === '/api/preview-distribution') {
        const start = Number(url.searchParams.get('startTime'));
        const end = Number(url.searchParams.get('endTime'));
        const count = parseInt(url.searchParams.get('targetRequests'), 10) || 100;
        const mode = url.searchParams.get('mode') || 'smart';
        const tz = url.searchParams.get('timezoneOffsetMinutes');

        const dist = buildTimeDistribution({
            startTime: start,
            endTime: end,
            targetClicks: count,
            mode,
            timezoneOffsetMinutes: hasTimezoneOffset(tz) ? Number(tz) : -420
        });

        return new Response(JSON.stringify({ success: true, data: dist }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }

    // ─── Static Asset Serving ─────────────────────────────────────────────────
    if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
    }

    return new Response('Traffic Benchmark Runner - Cloudflare Worker running.', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}

module.exports = {
    fetch: handleFetch,
    scheduled: handleScheduled
};
