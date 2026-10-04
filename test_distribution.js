const { buildTimeDistribution, generateClickSchedule, formatDuration } = require('./timeDistribution');

function runTests() {
    console.log('==================================================');
    console.log('BẮT ĐẦU KIỂM TRA 11 TEST CASES:');
    console.log('==================================================\n');

    let allPassed = true;

    // Helper to create dates in local time
    function makeDate(year, month, day, hour, minute) {
        return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
    }

    // CASE 1: 00:00 -> 03:00 (3 giờ), 100 lượt, Smart
    console.log('--- TEST CASE 1: 00:00 -> 03:00 | 100 lượt | Smart ---');
    const start1 = makeDate(2026, 8, 18, 0, 0);
    const end1   = makeDate(2026, 8, 18, 3, 0);
    const res1 = buildTimeDistribution({ startTime: start1, endTime: end1, targetClicks: 100, mode: 'smart' });
    const sched1 = generateClickSchedule(start1, end1, 100, 'smart');
    const totalQuota1 = res1.slices.reduce((sum, s) => sum + s.quota, 0);
    console.log(`Duration: ${res1.durationFormatted} (${res1.durationMs / 3600000}h)`);
    console.log(`Total Quota Slices: ${totalQuota1} / 100 | Timestamps: ${sched1.length}`);
    const pass1 = totalQuota1 === 100 && sched1.length === 100 && res1.slices.length === 3;
    console.log(`-> KẾT QUẢ: ${pass1 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass1) allPassed = false;

    // CASE 2: 16:35 -> 16:40 (5 phút), 100 lượt, Smart
    console.log('--- TEST CASE 2: 16:35 -> 16:40 | 100 lượt | Smart (Khoảng ngắn 5 phút) ---');
    const start2 = makeDate(2026, 8, 18, 16, 35);
    const end2   = makeDate(2026, 8, 18, 16, 40);
    const res2 = buildTimeDistribution({ startTime: start2, endTime: end2, targetClicks: 100, mode: 'smart' });
    const sched2 = generateClickSchedule(start2, end2, 100, 'smart');
    console.log(`Duration Formatted: "${res2.durationFormatted}" (Kỳ vọng: "5 phút", không hiển thị 0.1 tiếng)`);
    console.log(`Summary Blocks:`, res2.summaryBlocks);
    const totalQuota2 = res2.slices.reduce((sum, s) => sum + s.quota, 0);
    const pass2 = totalQuota2 === 100 && sched2.length === 100 && res2.durationFormatted === '5 phút';
    console.log(`-> KẾT QUẢ: ${pass2 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass2) allPassed = false;

    // CASE 3: 18:00 -> 03:00 hôm sau (9 giờ), 100 lượt, Smart
    console.log('--- TEST CASE 3: 18:00 -> 03:00 hôm sau | 100 lượt | Smart (Qua ngày hôm sau) ---');
    const start3 = makeDate(2026, 8, 18, 18, 0);
    const end3   = makeDate(2026, 8, 19, 3, 0);
    const res3 = buildTimeDistribution({ startTime: start3, endTime: end3, targetClicks: 100, mode: 'smart' });
    const sched3 = generateClickSchedule(start3, end3, 100, 'smart');
    console.log(`Duration Formatted: "${res3.durationFormatted}" (${res3.durationMs / 3600000} giờ)`);
    console.log(`Số hourly slices: ${res3.slices.length} (Kỳ vọng: 9 slices)`);
    const totalQuota3 = res3.slices.reduce((sum, s) => sum + s.quota, 0);
    const pass3 = totalQuota3 === 100 && sched3.length === 100 && res3.slices.length === 9 && (res3.durationMs / 3600000 === 9);
    console.log(`-> KẾT QUẢ: ${pass3 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass3) allPassed = false;

    // CASE 4: 16:35 -> 03:20 hôm sau, 100 lượt, Smart (Cắt giữa giờ đầu & cuối)
    console.log('--- TEST CASE 4: 16:35 -> 03:20 hôm sau | 100 lượt | Smart (Start/End cắt giữa giờ) ---');
    const start4 = makeDate(2026, 8, 18, 16, 35);
    const end4   = makeDate(2026, 8, 19, 3, 20);
    const res4 = buildTimeDistribution({ startTime: start4, endTime: end4, targetClicks: 100, mode: 'smart' });
    const sched4 = generateClickSchedule(start4, end4, 100, 'smart');
    const firstSlice = res4.slices[0];
    const lastSlice = res4.slices[res4.slices.length - 1];
    console.log(`Slice đầu: ${firstSlice.startStr} -> ${firstSlice.endStr} (${firstSlice.durationMinutes} phút, quota: ${firstSlice.quota})`);
    console.log(`Slice cuối: ${lastSlice.startStr} -> ${lastSlice.endStr} (${lastSlice.durationMinutes} phút, quota: ${lastSlice.quota})`);
    const totalQuota4 = res4.slices.reduce((sum, s) => sum + s.quota, 0);
    const pass4 = totalQuota4 === 100 &&
                  sched4.length === 100 &&
                  firstSlice.durationMinutes === 25 &&
                  lastSlice.durationMinutes === 20;
    console.log(`-> KẾT QUẢ: ${pass4 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass4) allPassed = false;

    // CASE 5: 100 lượt, Đồng đều (Even)
    console.log('--- TEST CASE 5: 10:00 -> 15:00 (5 giờ) | 100 lượt | Đồng đều (Even) ---');
    const start5 = makeDate(2026, 8, 18, 10, 0);
    const end5   = makeDate(2026, 8, 18, 15, 0);
    const res5 = buildTimeDistribution({ startTime: start5, endTime: end5, targetClicks: 100, mode: 'even' });
    const sched5 = generateClickSchedule(start5, end5, 100, 'even');
    console.log(`Quotas các slices 5 giờ:`, res5.slices.map(s => `${s.startStr}-${s.endStr}: ${s.quota}`));
    const totalQuota5 = res5.slices.reduce((sum, s) => sum + s.quota, 0);
    // Each 1-hour slice out of 5 hours should get 20 clicks
    const pass5 = totalQuota5 === 100 && res5.slices.every(s => s.quota === 20);
    console.log(`-> KẾT QUẢ: ${pass5 ? '✅ PASS (Mỗi giờ đều 20 lượt)' : '❌ FAIL'}\n`);
    if (!pass5) allPassed = false;

    // CASE 6: 100 lượt, Tùy chỉnh (Custom)
    console.log('--- TEST CASE 6: 00:00 -> 12:00 (12 giờ) | 100 lượt | Tùy chỉnh (Custom) ---');
    const start6 = makeDate(2026, 8, 18, 0, 0);
    const end6   = makeDate(2026, 8, 18, 12, 0);
    const customBlocks = {
        night: 'low',          // 00h-06h: low
        early_morning: 'medium', // 06h-09h: medium
        morning: 'high'        // 09h-12h: high
    };
    const res6 = buildTimeDistribution({ startTime: start6, endTime: end6, targetClicks: 100, mode: 'custom', customBlocks });
    const sched6 = generateClickSchedule(start6, end6, 100, 'custom', customBlocks);
    const totalQuota6 = res6.slices.reduce((sum, s) => sum + s.quota, 0);
    const nightQuota = res6.slices.filter(s => s.hourOfDay < 6).reduce((a, b) => a + b.quota, 0);
    const morningQuota = res6.slices.filter(s => s.hourOfDay >= 9 && s.hourOfDay < 12).reduce((a, b) => a + b.quota, 0);
    console.log(`Quota Đêm (6h, low): ${nightQuota} | Quota Sáng cao điểm (3h, high): ${morningQuota}`);
    console.log(`Total: ${totalQuota6} / 100`);
    const pass6 = totalQuota6 === 100 && morningQuota > nightQuota;
    console.log(`-> KẾT QUẢ: ${pass6 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass6) allPassed = false;

    // CASE 7: Kiểm tra tổng quota = targetClicks trên nhiều test case ngẫu nhiên
    console.log('--- TEST CASE 7: Kiểm tra sum(all quotas) === targetClicks trên 20 tổ hợp thời gian/clicks ngẫu nhiên ---');
    let pass7 = true;
    for (let i = 0; i < 20; i++) {
        const randClicks = Math.floor(Math.random() * 5000) + 1;
        const randStart = Date.now() + Math.floor(Math.random() * 86400000);
        const randDuration = Math.floor(Math.random() * (72 * 3600000)) + 60000; // 1 min to 72 hours
        const randEnd = randStart + randDuration;
        const mode = ['smart', 'even', 'custom'][i % 3];

        const res = buildTimeDistribution({ startTime: randStart, endTime: randEnd, targetClicks: randClicks, mode });
        const sumQuota = res.slices.reduce((sum, s) => sum + s.quota, 0);
        if (sumQuota !== randClicks) {
            console.error(`Mismatch on test ${i}: target=${randClicks}, got=${sumQuota}`);
            pass7 = false;
        }
    }
    console.log(`-> KẾT QUẢ: ${pass7 ? '✅ PASS (20/20 tổ hợp đều đúng 100% targetClicks)' : '❌ FAIL'}\n`);
    if (!pass7) allPassed = false;

    // CASE 8: Kiểm tra mọi block.start >= startTime và block.end <= endTime, timestamps trong bounds
    console.log('--- TEST CASE 8: Kiểm tra bounds an toàn: mọi block.start >= startTime, block.end <= endTime, timestamps trong bounds ---');
    let pass8 = true;
    for (const testDist of [res1, res2, res3, res4, res5, res6]) {
        for (const s of testDist.slices) {
            if (s.start < testDist.startMs || s.end > testDist.endMs) {
                console.error(`Slice out of bounds! start=${s.start}, end=${s.end}`);
                pass8 = false;
            }
        }
    }
    for (const [sched, st, en] of [[sched1, start1, end1], [sched2, start2, end2], [sched3, start3, end3], [sched4, start4, end4], [sched5, start5, end5], [sched6, start6, end6]]) {
        for (const t of sched) {
            if (t < st || t > en) {
                console.error(`Timestamp out of bounds! t=${t}, st=${st}, en=${en}`);
                pass8 = false;
            }
        }
    }
    console.log(`-> KẾT QUẢ: ${pass8 ? '✅ PASS (Tất cả slices và timestamps đều nằm chính xác trong [startTime, endTime])' : '❌ FAIL'}\n`);
    if (!pass8) allPassed = false;

    // CASE 9: Exact user scenario - 750 tasks, 07:00 -> 13:00, Even
    console.log('--- TEST CASE 9: 07:00 -> 13:00 | 750 lượt | Đồng đều (Even) ---');
    const start9 = makeDate(2026, 9, 24, 7, 0);
    const end9   = makeDate(2026, 9, 24, 13, 0);
    const res9 = buildTimeDistribution({ startTime: start9, endTime: end9, targetClicks: 750, mode: 'even' });
    const sched9 = generateClickSchedule(start9, end9, 750, 'even');
    const quotas9 = res9.slices.map(s => s.quota);
    const pass9 = sched9.length === 750 && quotas9.length === 6 && quotas9.every(q => q === 125) &&
        sched9.every(t => t >= start9 && t < end9);
    console.log(`Quotas: ${quotas9.join(' + ')} = ${quotas9.reduce((a,b) => a+b, 0)} | timestamps=${sched9.length}`);
    console.log(`-> KẾT QUẢ: ${pass9 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass9) allPassed = false;

    // CASE 10: Exact user scenario - 750 tasks, 07:00 -> 13:00, Smart
    console.log('--- TEST CASE 10: 07:00 -> 13:00 | 750 lượt | Smart ---');
    const res10 = buildTimeDistribution({ startTime: start9, endTime: end9, targetClicks: 750, mode: 'smart' });
    const sched10 = generateClickSchedule(start9, end9, 750, 'smart');
    const quotas10 = res10.slices.map(s => s.quota);
    const expectedSmart = [86, 114, 152, 161, 142, 95];
    const pass10 = sched10.length === 750 && quotas10.length === 6 &&
        quotas10.every((q, i) => q === expectedSmart[i]) &&
        sched10.every(t => t >= start9 && t < end9);
    console.log(`Quotas: ${quotas10.join(' + ')} = ${quotas10.reduce((a,b) => a+b, 0)} | timestamps=${sched10.length}`);
    console.log(`-> KẾT QUẢ: ${pass10 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass10) allPassed = false;

    // CASE 11: Smart must use the browser timezone, not the VPS timezone.
    console.log('--- TEST CASE 11: Timezone VN (UTC+7) | 07:00 -> 13:00 | 750 lượt | Smart ---');
    // 07:00 in UTC+7 equals 00:00Z. JS getTimezoneOffset for UTC+7 is -420.
    const start11 = Date.UTC(2026, 8, 24, 0, 0, 0, 0);
    const end11 = Date.UTC(2026, 8, 24, 6, 0, 0, 0);
    const res11 = buildTimeDistribution({
        startTime: start11, endTime: end11, targetClicks: 750, mode: 'smart', timezoneOffsetMinutes: -420
    });
    const sched11 = generateClickSchedule(start11, end11, 750, 'smart', null, -420);
    const quotas11 = res11.slices.map(s => s.quota);
    const pass11 = quotas11.every((q, i) => q === expectedSmart[i]) &&
        res11.slices[0].startStr === '07:00' && res11.slices[res11.slices.length - 1].endStr === '13:00' &&
        sched11.length === 750 && sched11.every(t => t >= start11 && t < end11);
    console.log(`VN wall-clock: ${res11.slices[0].startStr} -> ${res11.slices[res11.slices.length - 1].endStr} | Quotas: ${quotas11.join(' + ')}`);
    console.log(`-> KẾT QUẢ: ${pass11 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass11) allPassed = false;

    console.log('==================================================');
    console.log(`TỔNG KẾT: ${allPassed ? '🎉 TẤT CẢ 11/11 TEST CASES ĐÃ PASS!' : '⚠️ CÓ TEST CASE BỊ LỖI!'}`);
    console.log('==================================================');
}

runTests();
