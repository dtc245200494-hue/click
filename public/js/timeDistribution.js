/**
 * timeDistribution.js
 * Core engine for Smart Hourly & Even Traffic Distribution
 * Features:
 *  - Real-time Adaptive Dynamic Pacing (auto-adjusts on server lag/delays)
 *  - Proportional Hare-Niemeyer Quota Allocation for UI charts & preview
 *  - Timezone-aware slice calculations (browser/local timezone)
 */

const SMART_HOURLY_WEIGHTS = {
    // 00:00 - 06:00: Thấp (đêm khuya)
    0: 0.25, 1: 0.15, 2: 0.10, 3: 0.10, 4: 0.15, 5: 0.30,
    // 06:00 - 09:00: Vừa (buổi sáng)
    6: 0.60, 7: 0.90, 8: 1.20,
    // 09:00 - 12:00: Cao (giờ làm việc sáng)
    9: 1.60, 10: 1.70, 11: 1.50,
    // 12:00 - 14:00: Vừa (nghỉ trưa)
    12: 1.00, 13: 1.10,
    // 14:00 - 18:00: Cao (giờ làm việc chiều)
    14: 1.60, 15: 1.80, 16: 1.70, 17: 1.50,
    // 18:00 - 22:00: Cao (buổi tối)
    18: 1.40, 19: 1.60, 20: 1.70, 21: 1.50,
    // 22:00 - 00:00: Vừa (khuya)
    22: 1.00, 23: 0.60
};

const TIME_BLOCK_DEFINITIONS = [
    { id: 'night', label: '🌙 Đêm (00h-06h)', hours: [0, 1, 2, 3, 4, 5], color: '#64748b' },
    { id: 'early', label: '🌅 Sáng sớm (06h-09h)', hours: [6, 7, 8], color: '#f59e0b' },
    { id: 'morn',  label: '💼 Sáng cao điểm (09h-12h)', hours: [9, 10, 11], color: '#22c55e' },
    { id: 'noon',  label: '🍱 Trưa (12h-14h)', hours: [12, 13], color: '#38bdf8' },
    { id: 'after', label: '📈 Chiều cao điểm (14h-18h)', hours: [14, 15, 16, 17], color: '#818cf8' },
    { id: 'eve',   label: '📱 Tối cao điểm (18h-22h)', hours: [18, 19, 20, 21], color: '#ec4899' },
    { id: 'late',  label: '🌜 Khuya (22h-00h)', hours: [22, 23], color: '#a855f7' }
];

function hasTimezoneOffset(tz) {
    return tz !== null && tz !== undefined && tz !== '' && Number.isFinite(Number(tz));
}

function formatDuration(durationMs) {
    if (durationMs <= 0) return '0 giây';
    const totalSecs = Math.round(durationMs / 1000);
    const totalMins = Math.floor(totalSecs / 60);
    const secsRemaining = totalSecs % 60;

    if (totalSecs < 60) {
        return `${totalSecs} giây`;
    }

    if (totalMins < 60) {
        return secsRemaining > 0 ? `${totalMins} phút ${secsRemaining}s` : `${totalMins} phút`;
    }

    const totalHours = Math.floor(totalMins / 60);
    const minsRemaining = totalMins % 60;

    if (totalHours < 24) {
        return minsRemaining > 0 ? `${totalHours} giờ ${minsRemaining} phút` : `${totalHours} giờ`;
    }

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

function formatTimeOnly(dateOrMs, timezoneOffsetMinutes = null) {
    const ms = dateOrMs instanceof Date ? dateOrMs.getTime() : Number(dateOrMs);
    const d = toOffsetDate(ms, timezoneOffsetMinutes);
    const hh = String(hasTimezoneOffset(timezoneOffsetMinutes) ? d.getUTCHours() : d.getHours()).padStart(2, '0');
    const mm = String(hasTimezoneOffset(timezoneOffsetMinutes) ? d.getUTCMinutes() : d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * Builds an exact, sliced time distribution model for visualization & initial quotas
 */
function buildTimeDistribution({ startTime, endTime, targetClicks, mode = 'smart', timezoneOffsetMinutes = null }) {
    const startMs = typeof startTime === 'number' ? startTime : new Date(startTime).getTime();
    const endMs = typeof endTime === 'number' ? endTime : new Date(endTime).getTime();
    const requests = parseInt(targetClicks, 10) || 0;

    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs || requests <= 0) {
        return {
            valid: false,
            startMs,
            endMs,
            targetClicks: requests,
            durationMs: 0,
            durationFormatted: '0 phút',
            slices: [],
            summaryBlocks: [],
            avgIntervalSec: 0
        };
    }

    const durationMs = endMs - startMs;
    const durationFormatted = formatDuration(durationMs);
    const avgIntervalSec = Number((durationMs / 1000 / requests).toFixed(1));

    // Choose weights map
    let hourlyWeightMap = SMART_HOURLY_WEIGHTS;
    if (mode === 'even') {
        hourlyWeightMap = {};
        for (let h = 0; h < 24; h++) hourlyWeightMap[h] = 1.0;
    }

    // 1. Break into exact real-time hourly slices
    const rawSlices = [];
    let curTime = startMs;

    while (curTime < endMs) {
        const nextHourTime = nextHourForTimezone(curTime, timezoneOffsetMinutes);
        const sliceEnd = Math.min(endMs, nextHourTime);

        const sliceDurationMs = sliceEnd - curTime;
        const hourOfDay = getHourForTimezone(curTime, timezoneOffsetMinutes);
        const baseWeight = hourlyWeightMap[hourOfDay] !== undefined ? hourlyWeightMap[hourOfDay] : 1.0;
        const weight = baseWeight * (sliceDurationMs / 3600000);

        rawSlices.push({
            start: curTime,
            end: sliceEnd,
            startStr: formatTimeOnly(curTime, timezoneOffsetMinutes),
            endStr: formatTimeOnly(sliceEnd, timezoneOffsetMinutes),
            durationMs: sliceDurationMs,
            durationMinutes: Number((sliceDurationMs / 60000).toFixed(1)),
            hourOfDay,
            weight
        });

        curTime = sliceEnd;
    }

    const totalWeight = rawSlices.reduce((sum, s) => sum + s.weight, 0);
    if (totalWeight <= 0) {
        return {
            valid: false,
            startMs, endMs, targetClicks: requests, durationMs, durationFormatted,
            slices: [], summaryBlocks: [], avgIntervalSec
        };
    }

    // 2. Allocate exact quotas (Hare-Niemeyer largest remainder method)
    let totalAllocated = 0;
    const slicesWithQuota = rawSlices.map((s, index) => {
        const exact = requests * (s.weight / totalWeight);
        const quota = Math.floor(exact);
        totalAllocated += quota;
        return {
            ...s,
            index,
            quota,
            remainder: exact - quota
        };
    });

    let remainderRequests = requests - totalAllocated;
    const sortedByRemainder = [...slicesWithQuota].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < sortedByRemainder.length && remainderRequests > 0; i++) {
        const targetIndex = sortedByRemainder[i].index;
        slicesWithQuota[targetIndex].quota += 1;
        remainderRequests--;
    }

    // Compute percent for each slice
    const slices = slicesWithQuota.map(s => ({
        ...s,
        percent: requests > 0 ? Number(((s.quota / requests) * 100).toFixed(1)) : 0
    }));

    // 3. Build human-friendly summary blocks for UI display
    let summaryBlocks = [];

    if (durationMs <= 60 * 60 * 1000) {
        summaryBlocks = [{
            id: 'exact_span',
            label: `⏱️ ${slices[0].startStr} → ${slices[slices.length - 1].endStr} (${durationFormatted})`,
            quota: requests,
            percent: 100,
            color: '#818cf8',
            durationFormatted
        }];
    } else {
        for (const bDef of TIME_BLOCK_DEFINITIONS) {
            const matchingSlices = slices.filter(s => bDef.hours.includes(s.hourOfDay));
            if (matchingSlices.length === 0) continue;

            const blockQuota = matchingSlices.reduce((sum, s) => sum + s.quota, 0);
            const blockDurationMs = matchingSlices.reduce((sum, s) => sum + s.durationMs, 0);
            const blockPercent = Number(((blockQuota / requests) * 100).toFixed(1));

            summaryBlocks.push({
                id: bDef.id,
                label: bDef.label,
                quota: blockQuota,
                percent: blockPercent,
                color: bDef.color,
                durationFormatted: formatDuration(blockDurationMs)
            });
        }
    }

    return {
        valid: true,
        startMs,
        endMs,
        targetClicks: requests,
        mode,
        timezoneOffsetMinutes: hasTimezoneOffset(timezoneOffsetMinutes) ? Number(timezoneOffsetMinutes) : null,
        durationMs,
        durationFormatted,
        avgIntervalSec,
        slices,
        summaryBlocks
    };
}

/**
 * Dynamically computes the adaptive interval until the next request.
 * Automatically recalibrates pace if server lags or pauses, preventing bursts!
 *
 * @param {Object} params
 * @param {number} params.now - Current timestamp (epoch ms)
 * @param {number} params.endTime - Campaign end timestamp (epoch ms)
 * @param {number} params.remainingRequests - Target requests remaining to fulfill
 * @param {string} params.mode - 'smart' | 'even'
 * @param {number|null} params.timezoneOffsetMinutes - Browser timezone offset
 * @returns {Object} { valid, timeRemainingMs, idealIntervalMs, jitteredIntervalMs, currentRatePerHour, quotaCurrentSlice }
 */
function calculateAdaptiveNextInterval({
    now = Date.now(),
    endTime,
    remainingRequests,
    mode = 'smart',
    timezoneOffsetMinutes = null
}) {
    const timeRemainingMs = endTime - now;
    if (timeRemainingMs <= 0 || remainingRequests <= 0) {
        return {
            valid: false,
            timeRemainingMs: Math.max(0, timeRemainingMs),
            remainingRequests: Math.max(0, remainingRequests),
            idealIntervalMs: 0,
            jitteredIntervalMs: 0,
            currentRatePerHour: 0
        };
    }

    if (mode === 'even') {
        const idealIntervalMs = timeRemainingMs / remainingRequests;
        const jitter = 0.92 + 0.16 * Math.random();
        const jitteredIntervalMs = Math.max(50, Math.round(idealIntervalMs * jitter));
        const currentRatePerHour = Number(((3600000 / idealIntervalMs)).toFixed(1));

        return {
            valid: true,
            timeRemainingMs,
            remainingRequests,
            idealIntervalMs: Math.round(idealIntervalMs),
            jitteredIntervalMs,
            currentRatePerHour,
            quotaCurrentSlice: Math.max(1, Math.round(remainingRequests * (Math.min(3600000, timeRemainingMs) / timeRemainingMs)))
        };
    }

    // SMART MODE:
    // Partition remaining time [now, endTime] into slices and weight them
    const remainingSlices = [];
    let cur = now;
    while (cur < endTime) {
        const nextHour = nextHourForTimezone(cur, timezoneOffsetMinutes);
        const sliceEnd = Math.min(endTime, nextHour);
        const sliceDur = sliceEnd - cur;
        const hour = getHourForTimezone(cur, timezoneOffsetMinutes);
        const baseW = SMART_HOURLY_WEIGHTS[hour] !== undefined ? SMART_HOURLY_WEIGHTS[hour] : 1.0;
        const weight = baseW * (sliceDur / 3600000);

        remainingSlices.push({
            start: cur,
            end: sliceEnd,
            durationMs: sliceDur,
            hour,
            baseW,
            weight
        });
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
            quotaCurrentSlice: remainingRequests
        };
    }

    // First slice is the current immediate slice
    const currentSlice = remainingSlices[0];
    const currentSliceFraction = currentSlice.weight / totalRemainingWeight;
    const currentSliceQuota = remainingRequests * currentSliceFraction;

    let idealIntervalMs;
    if (currentSliceQuota >= 1) {
        idealIntervalMs = currentSlice.durationMs / currentSliceQuota;
    } else {
        const spreadQuota = Math.max(currentSliceQuota, 0.05);
        idealIntervalMs = currentSlice.durationMs / spreadQuota;
    }

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
        currentHourWeight: currentSlice.baseW
    };
}

/**
 * Generate sorted request timestamps (legacy helper & baseline verification)
 */
function generateClickSchedule(startMs, endMs, count, mode = 'smart', customBlocks = null, timezoneOffsetMinutes = null) {
    const dist = buildTimeDistribution({
        startTime: startMs,
        endTime: endMs,
        targetClicks: count,
        mode,
        timezoneOffsetMinutes
    });

    if (!dist.valid || dist.slices.length === 0) return [];

    const timestamps = [];
    for (const slice of dist.slices) {
        if (slice.quota <= 0) continue;
        const subBucketSize = slice.durationMs / slice.quota;
        for (let q = 0; q < slice.quota; q++) {
            const subStart = slice.start + q * subBucketSize;
            const jitterMs = Math.floor(Math.random() * subBucketSize);
            const ts = Math.floor(subStart + jitterMs);
            timestamps.push(Math.min(slice.end - 1, Math.max(slice.start, ts)));
        }
    }

    timestamps.sort((a, b) => a - b);
    return timestamps;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SMART_HOURLY_WEIGHTS,
        TIME_BLOCK_DEFINITIONS,
        hasTimezoneOffset,
        toOffsetDate,
        getHourForTimezone,
        nextHourForTimezone,
        formatDuration,
        buildTimeDistribution,
        calculateAdaptiveNextInterval,
        generateClickSchedule
    };
}
