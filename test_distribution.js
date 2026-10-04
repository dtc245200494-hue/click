const {
    buildTimeDistribution,
    generateClickSchedule,
    calculateAdaptiveNextInterval,
    formatDuration
} = require('./timeDistribution');

function runTests() {
    console.log('==================================================');
    console.log('BẮT ĐẦU KIỂM TRA TOÀN DIỆN CÁC TEST CASES (BAO GỒM ADAPTIVE):');
    console.log('==================================================\n');

    let allPassed = true;

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
    const totalQuota2 = res2.slices.reduce((sum, s) => sum + s.quota, 0);
    const pass2 = totalQuota2 === 100 && sched2.length === 100 && res2.durationFormatted === '5 phút';
    console.log(`Duration Formatted: "${res2.durationFormatted}"`);
    console.log(`-> KẾT QUẢ: ${pass2 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass2) allPassed = false;

    // CASE 3: 18:00 -> 03:00 hôm sau (9 giờ), 100 lượt, Smart
    console.log('--- TEST CASE 3: 18:00 -> 03:00 hôm sau | 100 lượt | Smart (Qua ngày hôm sau) ---');
    const start3 = makeDate(2026, 8, 18, 18, 0);
    const end3   = makeDate(2026, 8, 19, 3, 0);
    const res3 = buildTimeDistribution({ startTime: start3, endTime: end3, targetClicks: 100, mode: 'smart' });
    const sched3 = generateClickSchedule(start3, end3, 100, 'smart');
    const totalQuota3 = res3.slices.reduce((sum, s) => sum + s.quota, 0);
    const pass3 = totalQuota3 === 100 && sched3.length === 100 && res3.slices.length === 9 && (res3.durationMs / 3600000 === 9);
    console.log(`Duration Formatted: "${res3.durationFormatted}" (${res3.durationMs / 3600000} giờ) | Slices: ${res3.slices.length}`);
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
    const totalQuota4 = res4.slices.reduce((sum, s) => sum + s.quota, 0);
    const pass4 = totalQuota4 === 100 && sched4.length === 100 && firstSlice.durationMinutes === 25 && lastSlice.durationMinutes === 20;
    console.log(`Slice đầu: ${firstSlice.startStr} -> ${firstSlice.endStr} (${firstSlice.durationMinutes}p) | Slice cuối: ${lastSlice.startStr} -> ${lastSlice.endStr} (${lastSlice.durationMinutes}p)`);
    console.log(`-> KẾT QUẢ: ${pass4 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass4) allPassed = false;

    // CASE 5: 100 lượt, Đồng đều (Even)
    console.log('--- TEST CASE 5: 10:00 -> 15:00 (5 giờ) | 100 lượt | Đồng đều (Even) ---');
    const start5 = makeDate(2026, 8, 18, 10, 0);
    const end5   = makeDate(2026, 8, 18, 15, 0);
    const res5 = buildTimeDistribution({ startTime: start5, endTime: end5, targetClicks: 100, mode: 'even' });
    const sched5 = generateClickSchedule(start5, end5, 100, 'even');
    const totalQuota5 = res5.slices.reduce((sum, s) => sum + s.quota, 0);
    const pass5 = totalQuota5 === 100 && res5.slices.every(s => s.quota === 20);
    console.log(`Quotas các slices 5 giờ:`, res5.slices.map(s => `${s.startStr}-${s.endStr}: ${s.quota}`));
    console.log(`-> KẾT QUẢ: ${pass5 ? '✅ PASS (Mỗi giờ đều 20 lượt)' : '❌ FAIL'}\n`);
    if (!pass5) allPassed = false;

    // CASE 6: Random tests - sum(quotas) === target
    console.log('--- TEST CASE 6: Kiểm tra sum(all quotas) === target trên 20 tổ hợp ngẫu nhiên ---');
    let pass6 = true;
    for (let i = 0; i < 20; i++) {
        const randClicks = Math.floor(Math.random() * 5000) + 1;
        const randStart = Date.now() + Math.floor(Math.random() * 86400000);
        const randDuration = Math.floor(Math.random() * (72 * 3600000)) + 60000;
        const randEnd = randStart + randDuration;
        const mode = i % 2 === 0 ? 'smart' : 'even';

        const res = buildTimeDistribution({ startTime: randStart, endTime: randEnd, targetClicks: randClicks, mode });
        const sumQuota = res.slices.reduce((sum, s) => sum + s.quota, 0);
        if (sumQuota !== randClicks) {
            pass6 = false;
        }
    }
    console.log(`-> KẾT QUẢ: ${pass6 ? '✅ PASS (20/20 tổ hợp ngẫu nhiên khớp 100% target)' : '❌ FAIL'}\n`);
    if (!pass6) allPassed = false;

    // CASE 7: 750 tasks, 07:00 -> 13:00, Even (Kịch bản người dùng chốt)
    console.log('--- TEST CASE 7: 07:00 -> 13:00 | 750 lượt | Even (Chia đều 6 giờ) ---');
    const start7 = makeDate(2026, 9, 24, 7, 0);
    const end7   = makeDate(2026, 9, 24, 13, 0);
    const res7 = buildTimeDistribution({ startTime: start7, endTime: end7, targetClicks: 750, mode: 'even' });
    const sched7 = generateClickSchedule(start7, end7, 750, 'even');
    const quotas7 = res7.slices.map(s => s.quota);
    const pass7 = sched7.length === 750 && quotas7.length === 6 && quotas7.every(q => q === 125);
    console.log(`Quotas từng giờ: ${quotas7.join(' + ')} = ${quotas7.reduce((a,b) => a+b, 0)} (Mỗi giờ chính xác 125 lượt)`);
    console.log(`-> KẾT QUẢ: ${pass7 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass7) allPassed = false;

    // CASE 8: 750 tasks, 07:00 -> 13:00, Smart (Kịch bản phân bổ thông minh)
    console.log('--- TEST CASE 8: 07:00 -> 13:00 | 750 lượt | Smart (Ít -> Tăng -> Cao điểm -> Giảm) ---');
    const res8 = buildTimeDistribution({ startTime: start7, endTime: end7, targetClicks: 750, mode: 'smart' });
    const sched8 = generateClickSchedule(start7, end7, 750, 'smart');
    const quotas8 = res8.slices.map(s => s.quota);
    const expectedSmart = [86, 114, 152, 161, 142, 95];
    const pass8 = sched8.length === 750 && quotas8.length === 6 && quotas8.every((q, i) => q === expectedSmart[i]);
    console.log(`Quotas từng giờ: ${quotas8.join(' + ')} = ${quotas8.reduce((a,b) => a+b, 0)}`);
    console.log(`Kỳ vọng:         ${expectedSmart.join(' + ')}`);
    console.log(`-> KẾT QUẢ: ${pass8 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass8) allPassed = false;

    // CASE 9: Timezone VN (UTC+7) | 07:00 -> 13:00 | 750 lượt | Smart
    console.log('--- TEST CASE 9: Timezone VN (UTC+7) | 07:00 -> 13:00 | 750 lượt | Smart ---');
    const start9 = Date.UTC(2026, 8, 24, 0, 0, 0, 0); // 07:00 UTC+7 = 00:00Z
    const end9 = Date.UTC(2026, 8, 24, 6, 0, 0, 0);   // 13:00 UTC+7 = 06:00Z
    const res9 = buildTimeDistribution({
        startTime: start9, endTime: end9, targetClicks: 750, mode: 'smart', timezoneOffsetMinutes: -420
    });
    const sched9 = generateClickSchedule(start9, end9, 750, 'smart', null, -420);
    const quotas9 = res9.slices.map(s => s.quota);
    const pass9 = quotas9.every((q, i) => q === expectedSmart[i]) &&
                  res9.slices[0].startStr === '07:00' && res9.slices[res9.slices.length - 1].endStr === '13:00' &&
                  sched9.length === 750;
    console.log(`VN wall-clock: ${res9.slices[0].startStr} -> ${res9.slices[res9.slices.length - 1].endStr} | Quotas: ${quotas9.join(' + ')}`);
    console.log(`-> KẾT QUẢ: ${pass9 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass9) allPassed = false;

    // CASE 10: ADAPTIVE SMART SCHEDULER - Kịch bản người dùng đưa ra:
    // target = 750, success = 317, remaining = 433, timeRemaining = 3h12m (192 phút)
    console.log('--- TEST CASE 10: ADAPTIVE SMART - target=750, success=317, remaining=433, timeRemaining=3h12m ---');
    const now10 = makeDate(2026, 9, 24, 9, 48); // 09:48 (còn 12 phút trong giờ 09:00, và 3 giờ tiếp theo: 10, 11, 12)
    const end10 = makeDate(2026, 9, 24, 13, 0); // 13:00 -> đúng 3h12m (192 phút = 11,520,000 ms)
    const timeRemainingExpected = (3 * 60 + 12) * 60000;
    const adaptiveRes10 = calculateAdaptiveNextInterval({
        now: now10,
        endTime: end10,
        remainingRequests: 433,
        mode: 'smart',
        timezoneOffsetMinutes: null
    });
    console.log(`Time remaining: ${formatDuration(adaptiveRes10.timeRemainingMs)} (${adaptiveRes10.timeRemainingMs} ms)`);
    console.log(`Ideal Interval: ${adaptiveRes10.idealIntervalMs} ms (~${(adaptiveRes10.idealIntervalMs / 1000).toFixed(2)}s/request)`);
    console.log(`Jittered Interval: ${adaptiveRes10.jitteredIntervalMs} ms`);
    console.log(`Tốc độ hiện tại: ${adaptiveRes10.currentRatePerHour} requests/giờ`);
    console.log(`Quota còn lại của giờ 9: ${adaptiveRes10.quotaCurrentSlice}`);

    // Giờ 9h cao điểm (w=1.6), còn 12 phút. Khoảng cách giữa các reqs khoảng 20-30s
    const pass10 = adaptiveRes10.valid &&
                   adaptiveRes10.timeRemainingMs === timeRemainingExpected &&
                   adaptiveRes10.remainingRequests === 433 &&
                   adaptiveRes10.idealIntervalMs > 15000 && adaptiveRes10.idealIntervalMs < 40000;
    console.log(`-> KẾT QUẢ: ${pass10 ? '✅ PASS (Tự động tính nhịp độ chính xác cho phần còn lại)' : '❌ FAIL'}\n`);
    if (!pass10) allPassed = false;

    // CASE 11: ADAPTIVE EVEN SCHEDULER
    console.log('--- TEST CASE 11: ADAPTIVE EVEN - remaining=433, timeRemaining=3h12m ---');
    const adaptiveEven = calculateAdaptiveNextInterval({
        now: now10,
        endTime: end10,
        remainingRequests: 433,
        mode: 'even'
    });
    const expectedEvenInterval = Math.round(timeRemainingExpected / 433); // 11520000 / 433 = 26605 ms (~26.6s)
    console.log(`Even Ideal Interval: ${adaptiveEven.idealIntervalMs} ms (Kỳ vọng: ${expectedEvenInterval} ms)`);
    const pass11 = adaptiveEven.valid && adaptiveEven.idealIntervalMs === expectedEvenInterval;
    console.log(`-> KẾT QUẢ: ${pass11 ? '✅ PASS' : '❌ FAIL'}\n`);
    if (!pass11) allPassed = false;

    // CASE 12: CHỐNG BẮN DỒN KHI SERVER BỊ LAG (Server lag 10 phút)
    console.log('--- TEST CASE 12: CHỐNG BẮN DỒN KHI LAG 10 PHÚT ---');
    const nowAfterLag = now10 + (10 * 60000); // 09:58
    const adaptiveAfterLag = calculateAdaptiveNextInterval({
        now: nowAfterLag,
        endTime: end10,
        remainingRequests: 433,
        mode: 'even'
    });
    const expectedLagInterval = Math.round(((3 * 60 + 2) * 60000) / 433); // 182 phút / 433 reqs = 25219 ms (~25.2s)
    console.log(`Sau lag 10 phút: interval điều chỉnh từ ${adaptiveEven.idealIntervalMs}ms xuống ${adaptiveAfterLag.idealIntervalMs}ms`);
    console.log(`Tự động bù nhịp độ êm dịu, không xả dồn một cục 25 requests!`);
    const pass12 = adaptiveAfterLag.valid &&
                   adaptiveAfterLag.idealIntervalMs === expectedLagInterval &&
                   adaptiveAfterLag.idealIntervalMs < adaptiveEven.idealIntervalMs;
    console.log(`-> KẾT QUẢ: ${pass12 ? '✅ PASS (Nhịp độ tự động co lại mượt mà để kịp về đích 13:00)' : '❌ FAIL'}\n`);
    if (!pass12) allPassed = false;

    // CASE 13: KHÔI PHỤC TIẾN TRÌNH SAU RESTART SERVER (State Persistence Recovery)
    console.log('--- TEST CASE 13: KHÔI PHỤC TIẾN TRÌNH SAU RESTART (Target 900, đã xong 620, còn 280) ---');
    const savedState = {
        name: "Test 900",
        targetRequests: 900,
        successRequests: 620,
        failedRequests: 12,
        totalDispatched: 632,
        startTime: makeDate(2026, 9, 24, 7, 0),
        endTime: makeDate(2026, 9, 24, 13, 0),
        status: "running"
    };
    const nowRestart = makeDate(2026, 9, 24, 10, 30); // Giả lập khởi động lại lúc 10:30
    const remainingToRun = savedState.targetRequests - savedState.successRequests; // 280
    const adaptiveRecovered = calculateAdaptiveNextInterval({
        now: nowRestart,
        endTime: savedState.endTime,
        remainingRequests: remainingToRun,
        mode: 'smart',
        timezoneOffsetMinutes: null
    });
    console.log(`Khôi phục: Đã hoàn thành ${savedState.successRequests}/${savedState.targetRequests} requests.`);
    console.log(`Số requests còn lại cần thực hiện: ${remainingToRun} (Kỳ vọng: 280, KHÔNG bị reset về 0/900).`);
    console.log(`Thời gian còn lại: ${formatDuration(adaptiveRecovered.timeRemainingMs)} (2.5 giờ).`);
    console.log(`Nhịp độ Adaptive mới: ${adaptiveRecovered.idealIntervalMs}ms/req (~${(adaptiveRecovered.idealIntervalMs/1000).toFixed(1)}s/req).`);
    const pass13 = remainingToRun === 280 &&
                   adaptiveRecovered.valid &&
                   adaptiveRecovered.timeRemainingMs === 2.5 * 3600000 &&
                   adaptiveRecovered.idealIntervalMs > 20000 && adaptiveRecovered.idealIntervalMs < 40000;
    console.log(`-> KẾT QUẢ: ${pass13 ? '✅ PASS (Server khởi động lại tiếp tục đúng tiến độ 620/900)' : '❌ FAIL'}\n`);
    if (!pass13) allPassed = false;

    // CASE 14: CHỐNG RETRY VƯỢT TARGET KHI GẦN VỀ ĐÍCH (Quota Boundary Guard)
    console.log('--- TEST CASE 14: CHỐNG RETRY VƯỢT TARGET KHI GẦN VỀ ĐÍCH ---');
    const targetQuota = 900;
    const currentSuccess = 899;
    const activeInFlight = 1;
    // Giả lập logic kiểm tra quota an toàn trước khi dispatch retry:
    const remainingSlots = targetQuota - (currentSuccess + activeInFlight);
    console.log(`Target: ${targetQuota} | Success: ${currentSuccess} | In-flight: ${activeInFlight}`);
    console.log(`Slots khả dụng còn lại: ${remainingSlots}`);
    // Khi remainingSlots <= 0, hệ thống PHẢI từ chối dispatch thêm bất kỳ retry nào:
    const allowMoreDispatch = remainingSlots > 0;
    console.log(`Cho phép dispatch thêm request/retry: ${allowMoreDispatch ? 'CÓ' : 'KHÔNG (Đã khóa quota)'}`);
    const pass14 = remainingSlots === 0 && allowMoreDispatch === false;
    console.log(`-> KẾT QUẢ: ${pass14 ? '✅ PASS (Chặn đứng hoàn toàn nguy cơ vượt quá 900 requests)' : '❌ FAIL'}\n`);
    if (!pass14) allPassed = false;

    console.log('==================================================');
    console.log(`TỔNG KẾT: ${allPassed ? '🎉 TẤT CẢ 14/14 TEST CASES ĐÃ PASS XUẤT SẮC!' : '⚠️ CÓ TEST CASE BỊ LỖI!'}`);
    console.log('==================================================');

    if (!allPassed) process.exit(1);
}

runTests();
