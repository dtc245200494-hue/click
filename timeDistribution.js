/**
 * timeDistribution.js
 * Core module for Smart Hourly, Even, and Custom Traffic Distribution
 * Shared logic between Backend Scheduler & Frontend Preview
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

const CUSTOM_LEVEL_WEIGHTS = {
    'low': 0.30,
    'medium': 1.00,
    'high': 1.80
};

const TIME_BLOCK_DEFINITIONS = [
    { id: 'night', label: '🌙 Đêm (00h-06h)', hours: [0, 1, 2, 3, 4, 5], color: '#64748b', defaultLevel: 'low' },
    { id: 'early', label: '🌅 Sáng sớm (06h-09h)', hours: [6, 7, 8], color: '#f59e0b', defaultLevel: 'medium' },
    { id: 'morn',  label: '💼 Sáng cao điểm (09h-12h)', hours: [9, 10, 11], color: '#22c55e', defaultLevel: 'high' },
    { id: 'noon',  label: '🍱 Trưa (12h-14h)', hours: [12, 13], color: '#38bdf8', defaultLevel: 'medium' },
    { id: 'after', label: '📈 Chiều cao điểm (14h-18h)', hours: [14, 15, 16, 17], color: '#818cf8', defaultLevel: 'high' },
    { id: 'eve',   label: '📱 Tối cao điểm (18h-22h)', hours: [18, 19, 20, 21], color: '#ec4899', defaultLevel: 'high' },
    { id: 'late',  label: '🌜 Khuya (22h-00h)', hours: [22, 23], color: '#a855f7', defaultLevel: 'medium' }
];

function buildHourlyWeightsFromCustomBlocks(blocks) {
    if (!blocks) return SMART_HOURLY_WEIGHTS;
    const weights = {};
    const getVal = (blockName, def) => CUSTOM_LEVEL_WEIGHTS[blocks[blockName]] || def;

    const wNight = getVal('night', 0.25);
    for (let h = 0; h < 6; h++) weights[h] = wNight;

    const wEarly = getVal('early_morning', 0.9);
    for (let h = 6; h < 9; h++) weights[h] = wEarly;

    const wMorn = getVal('morning', 1.6);
    for (let h = 9; h < 12; h++) weights[h] = wMorn;

    const wNoon = getVal('noon', 1.0);
    for (let h = 12; h < 14; h++) weights[h] = wNoon;

    const wAfter = getVal('afternoon', 1.7);
    for (let h = 14; h < 18; h++) weights[h] = wAfter;

    const wEve = getVal('evening', 1.5);
    for (let h = 18; h < 22; h++) weights[h] = wEve;

    const wLate = getVal('late_night', 0.6);
    for (let h = 22; h < 24; h++) weights[h] = wLate;

    return weights;
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
    if (!Number.isFinite(Number(timezoneOffsetMinutes))) return new Date(ms);
    // JS getTimezoneOffset convention: UTC - local time. Bangkok is -420.
    return new Date(ms - Number(timezoneOffsetMinutes) * 60000);
}

function getHourForTimezone(ms, timezoneOffsetMinutes = null) {
    const d = toOffsetDate(ms, timezoneOffsetMinutes);
    return Number.isFinite(Number(timezoneOffsetMinutes)) ? d.getUTCHours() : d.getHours();
}

function nextHourForTimezone(ms, timezoneOffsetMinutes = null) {
    if (!Number.isFinite(Number(timezoneOffsetMinutes))) {
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
    const hh = String(Number.isFinite(Number(timezoneOffsetMinutes)) ? d.getUTCHours() : d.getHours()).padStart(2, '0');
    const mm = String(Number.isFinite(Number(timezoneOffsetMinutes)) ? d.getUTCMinutes() : d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * Builds an exact, sliced time distribution model
 */
function buildTimeDistribution({ startTime, endTime, targetClicks, mode = 'smart', customBlocks = null, timezoneOffsetMinutes = null }) {
    const startMs = typeof startTime === 'number' ? startTime : new Date(startTime).getTime();
    const endMs = typeof endTime === 'number' ? endTime : new Date(endTime).getTime();
    const clicks = parseInt(targetClicks, 10) || 0;

    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs || clicks <= 0) {
        return {
            valid: false,
            startMs,
            endMs,
            targetClicks: clicks,
            durationMs: 0,
            durationFormatted: '0 phút',
            slices: [],
            summaryBlocks: [],
            avgIntervalSec: 0
        };
    }

    const durationMs = endMs - startMs;
    const durationFormatted = formatDuration(durationMs);
    const avgIntervalSec = Number((durationMs / 1000 / clicks).toFixed(1));

    // Choose weights map
    let hourlyWeightMap = SMART_HOURLY_WEIGHTS;
    if (mode === 'even') {
        hourlyWeightMap = {};
        for (let h = 0; h < 24; h++) hourlyWeightMap[h] = 1.0;
    } else if (mode === 'custom') {
        hourlyWeightMap = buildHourlyWeightsFromCustomBlocks(customBlocks);
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
            startMs, endMs, targetClicks: clicks, durationMs, durationFormatted,
            slices: [], summaryBlocks: [], avgIntervalSec
        };
    }

    // 2. Allocate exact quotas (Hare-Niemeyer largest remainder method)
    let totalAllocated = 0;
    const slicesWithQuota = rawSlices.map((s, index) => {
        const exact = clicks * (s.weight / totalWeight);
        const quota = Math.floor(exact);
        totalAllocated += quota;
        return {
            ...s,
            index,
            quota,
            remainder: exact - quota
        };
    });

    let remainderClicks = clicks - totalAllocated;
    // Sort copy by remainder descending to give remainder clicks to highest remainder
    const sortedByRemainder = [...slicesWithQuota].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < sortedByRemainder.length && remainderClicks > 0; i++) {
        const targetIndex = sortedByRemainder[i].index;
        slicesWithQuota[targetIndex].quota += 1;
        remainderClicks--;
    }

    // Compute percent for each slice
    const slices = slicesWithQuota.map(s => ({
        ...s,
        percent: clicks > 0 ? Number(((s.quota / clicks) * 100).toFixed(1)) : 0
    }));

    // 3. Build human-friendly summary blocks for UI display
    let summaryBlocks = [];

    if (durationMs <= 60 * 60 * 1000) {
        // Short time span (<= 1 hour): single summary block with exact time
        summaryBlocks = [{
            id: 'exact_span',
            label: `⏱️ ${slices[0].startStr} → ${slices[slices.length - 1].endStr} (${durationFormatted})`,
            quota: clicks,
            percent: 100,
            color: '#818cf8',
            durationFormatted
        }];
    } else {
        // Multi-hour: Group by standard categories
        for (const bDef of TIME_BLOCK_DEFINITIONS) {
            const matchingSlices = slices.filter(s => bDef.hours.includes(s.hourOfDay));
            if (matchingSlices.length === 0) continue;

            const blockQuota = matchingSlices.reduce((sum, s) => sum + s.quota, 0);
            const blockDurationMs = matchingSlices.reduce((sum, s) => sum + s.durationMs, 0);
            const blockPercent = Number(((blockQuota / clicks) * 100).toFixed(1));

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
        targetClicks: clicks,
        mode,
        timezoneOffsetMinutes: Number.isFinite(Number(timezoneOffsetMinutes)) ? Number(timezoneOffsetMinutes) : null,
        durationMs,
        durationFormatted,
        avgIntervalSec,
        slices,
        summaryBlocks
    };
}

/**
 * Generate sorted click timestamps for the campaign scheduler
 */
function generateClickSchedule(startMs, endMs, count, mode = 'smart', customBlocks = null, timezoneOffsetMinutes = null) {
    const dist = buildTimeDistribution({
        startTime: startMs,
        endTime: endMs,
        targetClicks: count,
        mode,
        customBlocks,
        timezoneOffsetMinutes
    });

    if (!dist.valid || dist.slices.length === 0) return [];

    const timestamps = [];

    for (const slice of dist.slices) {
        if (slice.quota <= 0) continue;
        const subBucketSize = slice.durationMs / slice.quota;
        for (let q = 0; q < slice.quota; q++) {
            const subStart = slice.start + q * subBucketSize;
            // Add subtle jitter inside sub-bucket
            const jitterMs = Math.floor(Math.random() * subBucketSize);
            const ts = Math.floor(subStart + jitterMs);
            // Ensure bounds
            timestamps.push(Math.min(slice.end - 1, Math.max(slice.start, ts)));
        }
    }

    timestamps.sort((a, b) => a - b);
    return timestamps;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SMART_HOURLY_WEIGHTS,
        CUSTOM_LEVEL_WEIGHTS,
        TIME_BLOCK_DEFINITIONS,
        toOffsetDate,
        getHourForTimezone,
        nextHourForTimezone,
        buildHourlyWeightsFromCustomBlocks,
        formatDuration,
        buildTimeDistribution,
        generateClickSchedule
    };
}
