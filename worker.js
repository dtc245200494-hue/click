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

function calculateAdaptiveNextInterval({ now = Date.now(), endTime, remainingRequests, mode = 'smart', timezoneOffsetMinutes = null, avgLatencyMs = 0 }) {
    const timeRemainingMs = endTime - now;
    if (timeRemainingMs <= 0 || remainingRequests <= 0)
        return { valid: false, timeRemainingMs: Math.max(0, timeRemainingMs), remainingRequests: Math.max(0, remainingRequests), idealIntervalMs: 0, jitteredIntervalMs: 0, currentRatePerHour: 0, feasibility: 'completed' };

    // Feasibility analysis: check if remaining target can physically execute before endTime
    let feasibility = 'achievable';
    const estimatedRequiredRunTimeMs = remainingRequests * (avgLatencyMs || 200);
    if (estimatedRequiredRunTimeMs > timeRemainingMs) {
        feasibility = 'lagging';
    } else if (estimatedRequiredRunTimeMs * 1.3 > timeRemainingMs) {
        feasibility = 'tight';
    }

    if (mode === 'even') {
        const idealIntervalMs = timeRemainingMs / remainingRequests;
        const jitter = 0.92 + 0.16 * Math.random();
        return {
            valid: true,
            timeRemainingMs,
            remainingRequests,
            idealIntervalMs: Math.round(idealIntervalMs),
            jitteredIntervalMs: Math.max(50, Math.round(idealIntervalMs * jitter)),
            currentRatePerHour: Number(((3600000 / idealIntervalMs)).toFixed(1)),
            quotaCurrentSlice: Math.max(1, Math.round(remainingRequests * (Math.min(3600000, timeRemainingMs) / timeRemainingMs))),
            feasibility,
            avgLatencyMs
        };
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
        return {
            valid: true,
            timeRemainingMs,
            remainingRequests,
            idealIntervalMs: Math.round(fallbackInterval),
            jitteredIntervalMs: Math.round(fallbackInterval * (0.92 + 0.16 * Math.random())),
            currentRatePerHour: Number(((3600000 / fallbackInterval)).toFixed(1)),
            quotaCurrentSlice: remainingRequests,
            feasibility,
            avgLatencyMs
        };
    }

    const currentSlice = remainingSlices[0];
    const currentSliceFraction = currentSlice.weight / totalRemainingWeight;
    const currentSliceQuota = remainingRequests * currentSliceFraction;
    let idealIntervalMs = currentSliceQuota >= 1 ? currentSlice.durationMs / currentSliceQuota : currentSlice.durationMs / Math.max(currentSliceQuota, 0.05);
    idealIntervalMs = Math.min(timeRemainingMs, Math.max(50, idealIntervalMs));
    const jitter = 0.92 + 0.16 * Math.random();
    const jitteredIntervalMs = Math.max(50, Math.round(idealIntervalMs * jitter));
    const currentRatePerHour = Number(((3600000 / idealIntervalMs)).toFixed(1));

    return {
        valid: true,
        timeRemainingMs,
        remainingRequests,
        idealIntervalMs: Math.round(idealIntervalMs),
        jitteredIntervalMs,
        quotaCurrentSlice: Number(currentSliceQuota.toFixed(2)),
        currentRatePerHour,
        currentHour: currentSlice.hour,
        currentHourWeight: currentSlice.baseW,
        feasibility,
        avgLatencyMs
    };
}

// ─── Utility Helpers & Credential Sanitizer ──────────────────────────────────

function formatVnTime(ms = Date.now()) {
    const d = new Date(ms + 7 * 3600000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

function sanitizeProxyGateway(gw) {
    if (!gw || typeof gw !== 'string') return '';
    try {
        const u = new URL(gw);
        if (u.password) {
            return `${u.protocol}//${u.username ? u.username + ':***@' : '***@'}${u.host}`;
        }
        return gw;
    } catch (_) {
        return gw.replace(/:\/\/[^@]*@/, '://***@');
    }
}

function sanitizeCampaignForClient(campaign) {
    if (!campaign) return null;
    const copy = JSON.parse(JSON.stringify(campaign));
    if (copy.proxyConfig) {
        if (Array.isArray(copy.proxyConfig.gateways)) {
            copy.proxyConfig.gateways = copy.proxyConfig.gateways.map(sanitizeProxyGateway);
        }
        if (copy.proxyConfig.currentGateway) {
            copy.proxyConfig.currentGateway = sanitizeProxyGateway(copy.proxyConfig.currentGateway);
        }
    }
    if (copy.lastGateway) {
        copy.lastGateway = sanitizeProxyGateway(copy.lastGateway);
    }
    if (Array.isArray(copy.recentLogs)) {
        copy.recentLogs = copy.recentLogs.map(log => ({
            ...log,
            gateway: log.gateway ? sanitizeProxyGateway(log.gateway) : null
        }));
    }
    return copy;
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
        return { success, statusCode: response.status, latencyMs, error: success ? null : `HTTP ${response.status}`, pageTitle: null, finalUrl: url };
    } catch (err) {
        const latencyMs = Date.now() - startTime;
        return { success: false, statusCode: null, latencyMs, error: err.name === 'AbortError' ? `Timeout (${timeoutMs}ms)` : err.message, pageTitle: null, finalUrl: url };
    }
}

// ─── Browserless.io Chromium Muscle Runner ────────────────────────────────────

async function executeBrowserlessJob(url, token, options = {}) {
    const startTime = Date.now();
    const timeoutMs = Math.max(5000, parseInt(options.timeoutMs, 10) || 15000);
    const proxyUrl = options.proxyUrl || null;
    const scenario = Array.isArray(options.scenario) && options.scenario.length > 0
        ? options.scenario
        : [{ action: 'goto', url, timeout: timeoutMs }];

    let proxyHostPort = null;
    let proxyAuth = null;
    if (proxyUrl) {
        try {
            const u = new URL(proxyUrl);
            proxyHostPort = `${u.protocol}//${u.host}`;
            if (u.username || u.password) {
                proxyAuth = {
                    username: decodeURIComponent(u.username),
                    password: decodeURIComponent(u.password)
                };
            }
        } catch (_) {
            proxyHostPort = proxyUrl;
        }
    }

    let endpoint = `https://chrome.browserless.io/function?token=${encodeURIComponent(token)}`;
    if (proxyHostPort) {
        endpoint += `&--proxy-server=${encodeURIComponent(proxyHostPort)}`;
    }

    // Stateless Puppeteer code executed inside Browserless Chromium container with Scenario Engine
    const script = `export default async ({ page }) => {
  const t0 = Date.now();
  const stepLogs = [];
  ${proxyAuth ? `try { await page.authenticate({ username: ${JSON.stringify(proxyAuth.username)}, password: ${JSON.stringify(proxyAuth.password)} }); } catch (_) {}` : ''}
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    const scenario = ${JSON.stringify(scenario)};
    let lastStatusCode = 200;

    for (let i = 0; i < scenario.length; i++) {
      const step = scenario[i];
      const sStart = Date.now();
      try {
        if (step.action === 'goto' || !step.action) {
          const target = step.url || ${JSON.stringify(url)};
          const res = await page.goto(target, {
            waitUntil: 'domcontentloaded',
            timeout: step.timeout || ${timeoutMs}
          });
          if (res) lastStatusCode = res.status();
          stepLogs.push({ step: i + 1, action: 'goto', target, status: 'ok', durationMs: Date.now() - sStart });
        } else if (step.action === 'waitForSelector') {
          await page.waitForSelector(step.selector, { timeout: step.timeout || 5000 });
          stepLogs.push({ step: i + 1, action: 'waitForSelector', selector: step.selector, status: 'ok', durationMs: Date.now() - sStart });
        } else if (step.action === 'click') {
          await page.waitForSelector(step.selector, { timeout: step.timeout || 5000 });
          await page.click(step.selector);
          stepLogs.push({ step: i + 1, action: 'click', selector: step.selector, status: 'ok', durationMs: Date.now() - sStart });
        } else if (step.action === 'type' || step.action === 'fill') {
          await page.waitForSelector(step.selector, { timeout: step.timeout || 5000 });
          await page.type(step.selector, step.value || '', { delay: 30 });
          stepLogs.push({ step: i + 1, action: 'type', selector: step.selector, status: 'ok', durationMs: Date.now() - sStart });
        } else if (step.action === 'assertText') {
          await page.waitForSelector(step.selector, { timeout: step.timeout || 5000 });
          const text = await page.$eval(step.selector, el => el.textContent || '');
          if (!text.includes(step.expected)) {
            throw new Error('Assert text failed: expected "' + step.expected + '", got "' + text.trim().slice(0, 60) + '"');
          }
          stepLogs.push({ step: i + 1, action: 'assertText', selector: step.selector, status: 'ok', durationMs: Date.now() - sStart });
        } else if (step.action === 'wait') {
          const waitDur = Math.min(step.duration || 1000, 5000);
          await new Promise(r => setTimeout(r, waitDur));
          stepLogs.push({ step: i + 1, action: 'wait', durationMs: waitDur, status: 'ok' });
        }
      } catch (stepErr) {
        stepLogs.push({ step: i + 1, action: step.action, status: 'failed', error: stepErr.message, durationMs: Date.now() - sStart });
        throw stepErr;
      }
    }

    const pageTitle = await page.title().catch(() => '');
    const finalUrl = page.url();
    const duration = Date.now() - t0;
    return {
      data: {
        success: lastStatusCode >= 200 && lastStatusCode < 400,
        statusCode: lastStatusCode,
        pageTitle,
        finalUrl,
        stepLogs,
        durationMs: duration
      },
      type: 'application/json'
    };
  } catch (err) {
    let errorScreenshot = null;
    try {
      errorScreenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 40 });
    } catch (_) {}
    return {
      data: {
        success: false,
        statusCode: 504,
        pageTitle: '',
        finalUrl: page ? page.url() : ${JSON.stringify(url)},
        stepLogs,
        errorScreenshot: errorScreenshot ? ('data:image/jpeg;base64,' + errorScreenshot) : null,
        durationMs: Date.now() - t0,
        error: err.message
      },
      type: 'application/json'
    };
  }
};`;

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs + 10000);
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/javascript',
                'User-Agent': 'Cloudflare-Worker-Brain/1.0'
            },
            body: script,
            signal: controller.signal
        });
        clearTimeout(timer);

        const latencyMs = Date.now() - startTime;
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            return {
                success: false,
                statusCode: res.status,
                latencyMs,
                error: `Browserless HTTP ${res.status}: ${errText.slice(0, 150)}`,
                pageTitle: null,
                finalUrl: url,
                stepLogs: [],
                errorScreenshot: null
            };
        }

        const raw = await res.json();
        const payload = (raw && raw.data) ? raw.data : (raw || {});
        const success = Boolean(payload.success);
        const statusCode = payload.statusCode || 200;
        const pageTitle = payload.pageTitle || payload.title || '';
        const finalUrl = payload.finalUrl || url;
        const actualLatency = payload.durationMs || latencyMs;

        return {
            success,
            statusCode,
            latencyMs: actualLatency,
            error: payload.error || (success ? null : `HTTP ${statusCode}`),
            pageTitle,
            finalUrl,
            stepLogs: payload.stepLogs || [],
            errorScreenshot: payload.errorScreenshot || null
        };
    } catch (err) {
        const latencyMs = Date.now() - startTime;
        return {
            success: false,
            statusCode: null,
            latencyMs,
            error: err.name === 'AbortError' ? `Timeout (${timeoutMs}ms)` : err.message,
            pageTitle: null,
            finalUrl: url,
            stepLogs: [],
            errorScreenshot: null
        };
    }
}

// ─── Decoupled Proxy / Gateway Manager ────────────────────────────────────────

function checkAndRotateProxy(campaign) {
    if (!campaign.proxyConfig || !campaign.proxyConfig.enabled) {
        return null;
    }
    const cfg = campaign.proxyConfig;
    const gateways = Array.isArray(cfg.gateways)
        ? cfg.gateways.map(g => (typeof g === 'string' ? g.trim() : '')).filter(Boolean)
        : [];
    if (gateways.length === 0) {
        cfg.currentGateway = null;
        return null;
    }

    const now = Date.now();
    const intervalMs = Math.max(10, parseInt(cfg.rotationIntervalSec, 10) || 300) * 1000;

    if (!cfg.lastRotatedAt || !cfg.currentGateway || (now - cfg.lastRotatedAt) >= intervalMs) {
        const nextIdx = cfg.currentGateway ? ((cfg.currentIndex || 0) + 1) % gateways.length : 0;
        cfg.currentIndex = nextIdx;
        cfg.currentGateway = gateways[nextIdx];
        cfg.lastRotatedAt = now;
        cfg.nextRotationAt = now + intervalMs;
    } else {
        cfg.nextRotationAt = cfg.lastRotatedAt + intervalMs;
    }

    return cfg.currentGateway;
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
                    campaign.hasStarted = true;
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

            // ── Idempotency & In-Flight Guard ──
            // Cloudflare DO Alarms are at-least-once. If an alarm retries while a job is currently dispatched and within timeout, skip.
            const timeoutWithBuffer = (campaign.timeoutMs || 15000) + 5000;
            if (campaign.currentJob && campaign.currentJob.status === 'dispatched') {
                if (now - campaign.currentJob.startedAt < timeoutWithBuffer) {
                    console.warn(`[DO Alarm] In-flight job #${campaign.currentJob.sequence} still running. Skipping duplicate tick.`);
                    return;
                }
            }

            // State machine: mark as started
            campaign.hasStarted = true;

            // Start-to-Start Baseline Timing: Record dispatch start timestamp
            const dispatchStartedAt = Date.now();
            const nextSeq = (campaign.jobSequence || 0) + 1;
            campaign.jobSequence = nextSeq;
            campaign.currentJob = {
                id: `${campaign.id}:${nextSeq}`,
                sequence: nextSeq,
                status: 'dispatched',
                startedAt: dispatchStartedAt
            };
            // Persist the dispatched state immediately to guard against retry race
            await this.storage.put('campaign', campaign);

            // Compute planned interval from start time (Start-to-Start baseline)
            const mode = campaign.executionMode || 'http';
            const adaptive = calculateAdaptiveNextInterval({
                now: dispatchStartedAt,
                endTime: campaign.endTime,
                remainingRequests: remaining,
                mode: campaign.scheduleMode || 'smart',
                timezoneOffsetMinutes: campaign.timezoneOffsetMinutes,
                avgLatencyMs: campaign.avgLatencyMs || 0
            });
            const minInterval = mode === 'browser' ? 1500 : 1000;
            let plannedIntervalMs = Math.max(minInterval, adaptive.jitteredIntervalMs || 5000);
            plannedIntervalMs = Math.min(plannedIntervalMs, Math.max(minInterval, campaign.endTime - dispatchStartedAt));

            // Decoupled Gateway / Proxy rotation (checked before each alarm tick)
            const activeGateway = checkAndRotateProxy(campaign);

            // Execute based on executionMode: 'browser' (Chromium via Browserless.io) or 'http' (Cloudflare fetch)
            let res;
            if (mode === 'browser') {
                const token = this.env?.BROWSERLESS_TOKEN;
                if (!token) {
                    throw new Error('BROWSERLESS_TOKEN chưa được cấu hình trong Cloudflare Secrets');
                }
                res = await executeBrowserlessJob(campaign.targetUrl, token, {
                    timeoutMs: campaign.timeoutMs || 15000,
                    proxyUrl: activeGateway,
                    scenario: campaign.scenario || null
                });
                campaign.lastPageTitle = res.pageTitle || '';
                campaign.lastFinalUrl = res.finalUrl || campaign.targetUrl;
                campaign.lastStepLogs = res.stepLogs || [];
                if (res.errorScreenshot) {
                    campaign.lastErrorScreenshot = res.errorScreenshot;
                } else if (res.success) {
                    campaign.lastErrorScreenshot = null;
                }
            } else {
                res = await executeWorkerRequest(campaign.targetUrl, campaign.timeoutMs || 8000);
            }

            const jobFinishedAt = Date.now();
            const reqViTime = formatVnTime(jobFinishedAt);

            // Update exponential moving average latency
            const alpha = 0.25;
            campaign.avgLatencyMs = campaign.avgLatencyMs
                ? Math.round(campaign.avgLatencyMs * (1 - alpha) + res.latencyMs * alpha)
                : res.latencyMs;

            campaign.totalDispatched = (campaign.totalDispatched || 0) + 1;
            if (res.success) {
                campaign.successRequests = (campaign.successRequests || 0) + 1;
            } else {
                campaign.failedRequests = (campaign.failedRequests || 0) + 1;
            }

            campaign.lastGateway = activeGateway ? sanitizeProxyGateway(activeGateway) : null;
            campaign.lastAlarmRun = jobFinishedAt;
            campaign.lastAlarmRunText = reqViTime;
            campaign.lastRequestTime = jobFinishedAt;
            campaign.lastRequestText = reqViTime;
            campaign.lastStatusCode = res.statusCode;
            campaign.lastLatencyMs = res.latencyMs;
            campaign.lastError = res.error ? sanitizeProxyGateway(res.error) : null;

            if (!Array.isArray(campaign.recentLogs)) campaign.recentLogs = [];
            const modeTag = mode === 'browser' ? '🌐 Browser QA' : '⚡ HTTP';
            const gwInfo = activeGateway ? ` [GW: ${sanitizeProxyGateway(activeGateway)}]` : '';
            const titleInfo = (mode === 'browser' && res.pageTitle) ? ` • "${res.pageTitle}"` : '';

            campaign.recentLogs.push({
                timestamp: reqViTime,
                statusCode: res.statusCode,
                latencyMs: res.latencyMs,
                success: res.success,
                mode,
                gateway: activeGateway ? sanitizeProxyGateway(activeGateway) : null,
                pageTitle: res.pageTitle || null,
                seq: nextSeq,
                text: res.success
                    ? `[#${nextSeq} ${modeTag} ${res.statusCode} OK] ${campaign.targetUrl}${gwInfo} (${res.latencyMs}ms)${titleInfo}`
                    : `[#${nextSeq} ${modeTag} Lỗi] ${res.error ? sanitizeProxyGateway(res.error) : 'Lỗi không xác định'}${gwInfo} (${res.latencyMs}ms)`
            });
            if (campaign.recentLogs.length > 50) campaign.recentLogs.shift();

            // Mark job completion & idempotency record
            campaign.lastCompletedSequence = nextSeq;
            campaign.currentJob = {
                id: `${campaign.id}:${nextSeq}`,
                sequence: nextSeq,
                status: 'completed',
                startedAt: dispatchStartedAt,
                finishedAt: jobFinishedAt
            };

            // Check if finished right now
            if ((campaign.successRequests || 0) >= campaign.targetRequests) {
                campaign.status = 'completed';
                campaign.actualEndTime = jobFinishedAt;
                await this.storage.put('campaign', campaign);
                await this.storage.deleteAlarm();
                return;
            }

            // ── Start-to-Start Timing Calculation ──
            // Target next alarm is strictly calculated from dispatch start, NOT completion!
            const targetNextAlarmTime = dispatchStartedAt + plannedIntervalMs;
            let nextAlarmTime;
            let schedulerLagMs = 0;

            if (jobFinishedAt >= targetNextAlarmTime) {
                // Job duration exceeded planned interval! Mark lag and run immediate debounce
                schedulerLagMs = jobFinishedAt - targetNextAlarmTime;
                nextAlarmTime = jobFinishedAt + 100;
            } else {
                schedulerLagMs = 0;
                nextAlarmTime = targetNextAlarmTime;
            }

            campaign.schedulerLagMs = schedulerLagMs;
            campaign.lastPlannedIntervalMs = plannedIntervalMs;
            campaign.feasibility = adaptive.feasibility;

            // Persist strongly consistent state in Durable Object
            await this.storage.put('campaign', campaign);

            // Reschedule alarm for the natural organic interval
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

        if (path === '/registry/next-id' && request.method === 'POST') {
            let currentCounter = await this.storage.get('campaign_counter');
            if (typeof currentCounter !== 'number') {
                const ids = await this.storage.get('campaign_ids') || [];
                currentCounter = ids.reduce((max, item) => Math.max(max, parseInt(item, 10) || 0), 0);
            }
            currentCounter += 1;
            await this.storage.put('campaign_counter', currentCounter);
            return new Response(JSON.stringify({ nextId: String(currentCounter) }), { headers: { 'Content-Type': 'application/json' } });
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
            data.jobSequence = data.jobSequence || 0;
            data.lastCompletedSequence = data.lastCompletedSequence || 0;
            data.currentJob = null;
            data.schedulerLagMs = 0;
            data.avgLatencyMs = 0;
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
            if (action === 'start' || action === 'resume') {
                if (['completed', 'expired'].includes(campaign.status)) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: 'Chiến dịch đã hoàn thành hoặc hết giờ. Hãy dùng chức năng Nhân bản (Clone) để tạo chiến dịch mới.'
                    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
                campaign.status = now >= campaign.startTime ? 'running' : 'waiting';
                if (!campaign.actualStartTime && campaign.status === 'running') campaign.actualStartTime = now;
                if (campaign.status === 'running') {
                    campaign.hasStarted = true;
                    await this.storage.setAlarm(now + 150);
                } else {
                    await this.storage.setAlarm(campaign.startTime);
                }
            } else if (action === 'pause') {
                if (campaign.status !== 'running') {
                    return new Response(JSON.stringify({ success: false, message: 'Chỉ có thể tạm dừng chiến dịch đang chạy' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
                campaign.status = 'paused';
                await this.storage.deleteAlarm();
            } else if (action === 'stop') {
                campaign.status = 'stopped';
                campaign.actualEndTime = now;
                await this.storage.deleteAlarm();
            } else if (action === 'reset') {
                // Strict check: Running and Paused MUST NOT be reset directly!
                if (['running', 'paused'].includes(campaign.status)) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: 'Phải Dừng (Stop) chiến dịch trước khi Reset.'
                    }), { status: 409, headers: { 'Content-Type': 'application/json' } });
                }
                campaign.status = 'stopped';
                campaign.hasStarted = false; // Reset unlocks config
                campaign.successRequests = 0;
                campaign.failedRequests = 0;
                campaign.totalDispatched = 0;
                campaign.jobSequence = 0;
                campaign.lastCompletedSequence = 0;
                campaign.currentJob = null;
                campaign.schedulerLagMs = 0;
                campaign.avgLatencyMs = 0;
                campaign.lastAlarmRun = null;
                campaign.lastAlarmRunText = null;
                campaign.lastRequestTime = null;
                campaign.lastRequestText = null;
                campaign.lastStatusCode = null;
                campaign.lastLatencyMs = null;
                campaign.lastError = null;
                campaign.lastPageTitle = null;
                campaign.lastFinalUrl = null;
                campaign.lastStepLogs = [];
                campaign.lastErrorScreenshot = null;
                campaign.lastGateway = null;
                if (campaign.proxyConfig) {
                    campaign.proxyConfig.currentIndex = 0;
                    campaign.proxyConfig.currentGateway = null;
                    campaign.proxyConfig.lastRotatedAt = null;
                    campaign.proxyConfig.nextRotationAt = null;
                }
                campaign.actualStartTime = null;
                campaign.actualEndTime = null;
                campaign.recentLogs = [];
                await this.storage.deleteAlarm();
            } else {
                return new Response(JSON.stringify({ success: false, message: `Thao tác '${action}' không hợp lệ` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            }
            await this.storage.put('campaign', campaign);
            return new Response(JSON.stringify({ success: true, status: campaign.status, hasStarted: campaign.hasStarted }), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/update' && request.method === 'PUT') {
            const body = await request.json();
            const campaign = await this.storage.get('campaign');
            if (!campaign) return new Response(JSON.stringify({ success: false, message: 'Chiến dịch không tồn tại' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

            // 1. Strict state check: CANNOT edit while running or paused
            if (['running', 'paused'].includes(campaign.status)) {
                return new Response(JSON.stringify({
                    success: false,
                    message: 'Chiến dịch đang chạy hoặc tạm dừng. Không thể chỉnh sửa cấu hình. Hãy Dừng (Stop) trước.'
                }), { status: 409, headers: { 'Content-Type': 'application/json' } });
            }

            // 2. State Machine Locking: Once started, lock all runtime fields
            if (campaign.hasStarted) {
                const lockedFields = [
                    'targetUrl', 'targetRequests', 'scheduleMode', 'startTime', 'endTime',
                    'executionMode', 'proxyConfig', 'maxConcurrent', 'timeoutMs',
                    'maxRetries', 'timezoneOffsetMinutes', 'scenario'
                ];
                const illegalFields = lockedFields.filter(field => {
                    if (body[field] === undefined) return false;
                    return JSON.stringify(body[field]) !== JSON.stringify(campaign[field]);
                });

                if (illegalFields.length > 0) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: `Chiến dịch đã từng chạy (Locked 🔒). Không thể thay đổi các trường: ${illegalFields.join(', ')}. Chỉ cho phép sửa tên chiến dịch. Hãy Reset sau khi Dừng nếu muốn cấu hình lại từ đầu, hoặc dùng chức năng Nhân bản.`
                    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
            }

            Object.assign(campaign, body);
            await this.storage.put('campaign', campaign);
            return new Response(JSON.stringify({ success: true, campaign }), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/delete' && request.method === 'DELETE') {
            const campaign = await this.storage.get('campaign');
            if (campaign && ['running', 'paused'].includes(campaign.status)) {
                return new Response(JSON.stringify({
                    success: false,
                    message: 'Không thể xóa chiến dịch đang chạy hoặc tạm dừng. Hãy Dừng (Stop) trước.'
                }), { status: 409, headers: { 'Content-Type': 'application/json' } });
            }
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

async function getNextCampaignId(env) {
    if (env && env.CAMPAIGN_RUNNER) {
        try {
            const regId = env.CAMPAIGN_RUNNER.idFromName('system:registry');
            const stub = env.CAMPAIGN_RUNNER.get(regId);
            const res = await stub.fetch('http://do/registry/next-id', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                if (data.nextId) return data.nextId;
            }
        } catch (e) {
            console.error('[DO Registry] Error generating next ID:', e.message);
        }
    }
    const list = await getCampaigns(env);
    return String(list.reduce((max, c) => Math.max(max, parseInt(c.id, 10) || 0), 0) + 1);
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
    const origin = request.headers.get('Origin');
    const isSameOrigin = !origin || origin === url.origin;
    const corsHeaders = {
        'Access-Control-Allow-Origin': isSameOrigin ? (origin || url.origin) : 'null',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Cf-Access-Jwt-Assertion',
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const cfAccessEmail = request.headers.get('Cf-Access-Authenticated-User-Email') || null;
    const cfAccessJwt = request.headers.get('Cf-Access-Jwt-Assertion') || null;

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
            serviceName: 'click-browserless',
            storage: isDO ? 'durable_objects' : ((env && env.CAMPAIGNS_KV) ? 'connected' : 'memory'),
            storageLabel: isDO ? '🟢 Durable Objects (Strong Consistency)' : '🟡 KV Storage',
            engine: isDO ? 'DO Alarms (Start-to-Start Smart Pacing)' : 'Cron Trigger',
            engineType: isDO ? 'durable_objects' : 'cron',
            accessControl: {
                authenticated: Boolean(cfAccessEmail),
                userEmail: cfAccessEmail || null,
                jwtPresent: Boolean(cfAccessJwt),
                status: cfAccessEmail ? 'protected' : 'open',
                label: cfAccessEmail ? `🛡️ Cloudflare Access (${cfAccessEmail})` : '⚠️ Public Access (Recommend Zero Trust)'
            },
            browserless: {
                status: env?.BROWSERLESS_TOKEN ? 'ready' : 'missing_token',
                tokenConfigured: Boolean(env?.BROWSERLESS_TOKEN),
                engine: 'Stateless Headless Chromium',
                capabilities: {
                    scenarioEngine: true,
                    pageInteraction: true,
                    screenshots: true,
                    externalProxy: 'requires_paid_plan'
                }
            },
            supportedModes: ['http', 'browser'],
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
            return sanitizeCampaignForClient({ ...c, remaining, progressPercent, config: { ...c } });
        });
        return new Response(JSON.stringify({ success: true, data: enriched }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // POST /api/campaigns/sample (Tạo chiến dịch mẫu Browser QA chạy ngay hôm nay)
    if (url.pathname === '/api/campaigns/sample' && request.method === 'POST') {
        const now = Date.now();
        const nextId = await getNextCampaignId(env);
        const sample = {
            id: nextId,
            name: `Browser QA Mẫu ${nextId} (${formatVnTime(now)})`,
            targetUrl: 'https://example.com',
            targetRequests: 50,
            startTime: now,
            endTime: now + 2 * 3600000,
            scheduleMode: 'smart',
            executionMode: 'browser',
            scenario: [
                { action: 'goto', url: 'https://example.com' },
                { action: 'waitForSelector', selector: 'h1', timeout: 5000 },
                { action: 'assertText', selector: 'h1', expected: 'Example' }
            ],
            proxyConfig: {
                enabled: false,
                gateways: [],
                rotationIntervalSec: 300,
                currentIndex: 0,
                currentGateway: null,
                lastRotatedAt: null,
                nextRotationAt: null
            },
            timeoutMs: 15000,
            maxConcurrent: 2,
            timezoneOffsetMinutes: -420,
            maxRetries: 1,
            status: 'running',
            hasStarted: true,
            jobSequence: 0,
            lastCompletedSequence: 0,
            currentJob: null,
            schedulerLagMs: 0,
            avgLatencyMs: 0,
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
            lastPageTitle: null,
            lastFinalUrl: null,
            lastStepLogs: [],
            lastErrorScreenshot: null,
            lastGateway: null,
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
            const list = await getCampaigns(env);
            list.push(sample);
            await saveCampaigns(env, list);
        }

        return new Response(JSON.stringify({ success: true, id: nextId, campaign: sanitizeCampaignForClient(sample) }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // POST /api/campaigns
    if (url.pathname === '/api/campaigns' && request.method === 'POST') {
        try {
            const body = await request.json();
            if (!body.targetUrl) return new Response(JSON.stringify({ success: false, message: 'targetUrl là bắt buộc' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

            const nextId = await getNextCampaignId(env);

            const executionMode = (body.executionMode === 'browser') ? 'browser' : 'http';
            const rawGateways = Array.isArray(body.proxyConfig?.gateways)
                ? body.proxyConfig.gateways
                : (typeof body.proxyConfig?.gateways === 'string'
                    ? body.proxyConfig.gateways.split('\n').map(s => s.trim()).filter(Boolean)
                    : []);
            const proxyConfig = {
                enabled: Boolean(body.proxyConfig?.enabled && rawGateways.length > 0),
                gateways: rawGateways,
                rotationIntervalSec: Math.max(10, parseInt(body.proxyConfig?.rotationIntervalSec, 10) || 300),
                currentIndex: 0,
                currentGateway: null,
                lastRotatedAt: null,
                nextRotationAt: null
            };

            const scenario = (executionMode === 'browser' && Array.isArray(body.scenario) && body.scenario.length > 0)
                ? body.scenario
                : null;

            const isStartNow = (Number(body.startTime) || Date.now()) <= Date.now();
            const newCampaign = {
                id: nextId,
                name: body.name || `Chiến dịch ${nextId}`,
                targetUrl: body.targetUrl,
                targetRequests: parseInt(body.targetRequests, 10) || 100,
                startTime: Number(body.startTime) || Date.now(),
                endTime: Number(body.endTime) || (Date.now() + 6 * 3600000),
                scheduleMode: body.scheduleMode === 'even' ? 'even' : 'smart',
                executionMode,
                scenario,
                proxyConfig,
                timeoutMs: parseInt(body.timeoutMs, 10) || (executionMode === 'browser' ? 15000 : 8000),
                maxConcurrent: Math.max(1, Math.min(20, parseInt(body.maxConcurrent, 10) || (executionMode === 'browser' ? 2 : 3))),
                timezoneOffsetMinutes: hasTimezoneOffset(body.timezoneOffsetMinutes) ? Number(body.timezoneOffsetMinutes) : -420,
                maxRetries: 1,
                status: isStartNow ? 'running' : 'waiting',
                hasStarted: isStartNow,
                jobSequence: 0,
                lastCompletedSequence: 0,
                currentJob: null,
                schedulerLagMs: 0,
                avgLatencyMs: 0,
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
                lastPageTitle: null,
                lastFinalUrl: null,
                lastStepLogs: [],
                lastErrorScreenshot: null,
                lastGateway: null,
                actualStartTime: isStartNow ? Date.now() : null,
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
                const list = await getCampaigns(env);
                list.push(newCampaign);
                await saveCampaigns(env, list);
            }

            return new Response(JSON.stringify({ success: true, id: nextId, campaign: sanitizeCampaignForClient(newCampaign) }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
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
                const doId = env.CAMPAIGN_RUNNER.idFromName(id);
                const stub = env.CAMPAIGN_RUNNER.get(doId);
                const res = await stub.fetch('http://do/delete', { method: 'DELETE' });
                const d = await res.json();
                if (!res.ok) {
                    return new Response(JSON.stringify(d), { status: res.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
                }
                await removeRegistryId(env, id);
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
                if (d.campaign) d.campaign = sanitizeCampaignForClient(d.campaign);
                return new Response(JSON.stringify(d), { status: res.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }

            if (request.method === 'POST') {
                let reqAction = action;
                if (!reqAction) {
                    try {
                        const b = await request.clone().json();
                        reqAction = b.action;
                    } catch (_) {}
                }
                const doId = env.CAMPAIGN_RUNNER.idFromName(id);
                const stub = env.CAMPAIGN_RUNNER.get(doId);
                const res = await stub.fetch('http://do/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: reqAction })
                });
                const d = await res.json();
                return new Response(JSON.stringify(d), { status: res.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }
        }

        // Fallback (KV / Memory)
        const list = await getCampaigns(env);
        const index = list.findIndex(c => String(c.id) === id);
        if (index === -1) return new Response(JSON.stringify({ success: false, message: 'Chiến dịch không tồn tại' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        const campaign = list[index];

        if (request.method === 'DELETE') {
            if (['running', 'paused'].includes(campaign.status)) {
                return new Response(JSON.stringify({
                    success: false,
                    message: 'Không thể xóa chiến dịch đang chạy hoặc tạm dừng. Hãy Dừng (Stop) trước.'
                }), { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }
            list.splice(index, 1);
            await saveCampaigns(env, list);
            return new Response(JSON.stringify({ success: true, message: `Đã xóa chiến dịch ${id}` }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        if (request.method === 'PUT') {
            const body = await request.json();

            // Strict state check: CANNOT edit while running or paused
            if (['running', 'paused'].includes(campaign.status)) {
                return new Response(JSON.stringify({
                    success: false,
                    message: 'Chiến dịch đang chạy hoặc tạm dừng. Không thể chỉnh sửa cấu hình. Hãy Dừng (Stop) trước.'
                }), { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }

            // State Machine Locking: Once started, lock all runtime fields
            if (campaign.hasStarted) {
                const lockedFields = [
                    'targetUrl', 'targetRequests', 'scheduleMode', 'startTime', 'endTime',
                    'executionMode', 'proxyConfig', 'maxConcurrent', 'timeoutMs',
                    'maxRetries', 'timezoneOffsetMinutes', 'scenario'
                ];
                const illegalFields = lockedFields.filter(f => body[f] !== undefined && JSON.stringify(body[f]) !== JSON.stringify(campaign[f]));
                if (illegalFields.length > 0) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: `Chiến dịch đã từng chạy (Locked 🔒). Không thể thay đổi các trường: ${illegalFields.join(', ')}. Chỉ cho phép sửa tên chiến dịch. Hãy Reset sau khi Dừng nếu muốn cấu hình lại từ đầu, hoặc dùng chức năng Nhân bản.`
                    }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
                }
            }

            Object.assign(campaign, body);
            await saveCampaigns(env, list);
            return new Response(JSON.stringify({ success: true, campaign: sanitizeCampaignForClient(campaign) }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        if (request.method === 'POST') {
            let reqAction = action;
            if (!reqAction) {
                try {
                    const b = await request.clone().json();
                    reqAction = b.action;
                } catch (_) {}
            }
            const now = Date.now();
            if (reqAction === 'start' || reqAction === 'resume') {
                if (['completed', 'expired'].includes(campaign.status)) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: 'Chiến dịch đã hoàn thành hoặc hết giờ. Hãy dùng chức năng Nhân bản (Clone) để tạo chiến dịch mới.'
                    }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
                }
                campaign.status = now >= campaign.startTime ? 'running' : 'waiting';
                if (!campaign.actualStartTime && campaign.status === 'running') campaign.actualStartTime = now;
                if (campaign.status === 'running') campaign.hasStarted = true;
            } else if (reqAction === 'pause') {
                if (campaign.status !== 'running') {
                    return new Response(JSON.stringify({ success: false, message: 'Chỉ có thể tạm dừng chiến dịch đang chạy' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
                }
                campaign.status = 'paused';
            } else if (reqAction === 'stop') {
                campaign.status = 'stopped';
                campaign.actualEndTime = now;
            } else if (reqAction === 'reset') {
                if (['running', 'paused'].includes(campaign.status)) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: 'Phải Dừng (Stop) chiến dịch trước khi Reset.'
                    }), { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
                }
                campaign.status = 'stopped';
                campaign.hasStarted = false;
                campaign.successRequests = 0;
                campaign.failedRequests = 0;
                campaign.totalDispatched = 0;
                campaign.jobSequence = 0;
                campaign.lastCompletedSequence = 0;
                campaign.currentJob = null;
                campaign.schedulerLagMs = 0;
                campaign.avgLatencyMs = 0;
                campaign.lastCronRun = null;
                campaign.lastCronRunText = null;
                campaign.lastRequestTime = null;
                campaign.lastRequestText = null;
                campaign.lastStatusCode = null;
                campaign.lastLatencyMs = null;
                campaign.lastError = null;
                campaign.lastPageTitle = null;
                campaign.lastFinalUrl = null;
                campaign.lastStepLogs = [];
                campaign.lastErrorScreenshot = null;
                campaign.lastGateway = null;
                campaign.actualStartTime = null;
                campaign.actualEndTime = null;
                campaign.recentLogs = [];
            } else {
                return new Response(JSON.stringify({ success: false, message: `Thao tác '${reqAction}' không hợp lệ` }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }
            await saveCampaigns(env, list);
            return new Response(JSON.stringify({ success: true, status: campaign.status, hasStarted: campaign.hasStarted }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
    }

    // POST /api/test-url
    if (url.pathname === '/api/test-url' && request.method === 'POST') {
        const body = await request.json();
        const testMode = body.mode === 'browser' ? 'browser' : 'http';
        let result;
        if (testMode === 'browser') {
            const token = env?.BROWSERLESS_TOKEN;
            if (!token) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'BROWSERLESS_TOKEN chưa được cấu hình trong Cloudflare Secrets'
                }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }
            result = await executeBrowserlessJob(body.url, token, {
                timeoutMs: parseInt(body.timeoutMs, 10) || 15000,
                proxyUrl: body.proxyUrl || null,
                scenario: Array.isArray(body.scenario) ? body.scenario : null
            });
        } else {
            result = await executeWorkerRequest(body.url, parseInt(body.timeoutMs, 10) || 5000);
        }
        if (result.error) result.error = sanitizeProxyGateway(result.error);
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

