/**
 * app.js - Frontend Controller for Traffic Benchmark Runner
 * Handles Real-time Socket.IO, Campaign CRUD, Distribution Visualizer, and Live Log Stream
 */

document.addEventListener('DOMContentLoaded', () => {
    // ─── Socket.IO & State ─────────────────────────────────────────────────────────
    const socket = (typeof io === 'function') ? io() : null;
    let campaigns = [];
    let selectedCampaignId = null;
    let autoScrollLogs = true;

    // ─── DOM References ───────────────────────────────────────────────────────────
    const wsStatus = document.getElementById('wsStatus');
    const globalTotalCampaigns = document.getElementById('globalTotalCampaigns');
    const globalRunningCampaigns = document.getElementById('globalRunningCampaigns');
    const globalSuccessRequests = document.getElementById('globalSuccessRequests');
    const globalTotalDispatched = document.getElementById('globalTotalDispatched');
    const globalAvgLatency = document.getElementById('globalAvgLatency');
    const campaignCountBadge = document.getElementById('campaignCountBadge');
    const campaignsContainer = document.getElementById('campaignsContainer');
    const emptyCampaignsState = document.getElementById('emptyCampaignsState');
    const consoleLogs = document.getElementById('consoleLogs');
    const btnClearLogs = document.getElementById('btnClearLogs');

    // Chart tab
    const chartCampaignTitle = document.getElementById('chartCampaignTitle');
    const chartCampaignSubtitle = document.getElementById('chartCampaignSubtitle');
    const chartSummaryBlocks = document.getElementById('chartSummaryBlocks');
    const chartBarsWrap = document.getElementById('chartBarsWrap');

    // Modal elements
    const campaignModal = document.getElementById('campaignModal');
    const campaignForm = document.getElementById('campaignForm');
    const modalTitle = document.getElementById('modalTitle');
    const editCampaignId = document.getElementById('editCampaignId');
    const btnOpenCreateModal = document.getElementById('btnOpenCreateModal');
    const btnEmptyCreate = document.getElementById('btnEmptyCreate');
    const btnCloseModal = document.getElementById('btnCloseModal');
    const btnCancelModal = document.getElementById('btnCancelModal');
    const btnTestUrl = document.getElementById('btnTestUrl');
    const pingResult = document.getElementById('pingResult');

    // Form inputs
    const inputName = document.getElementById('inputName');
    const inputTargetUrl = document.getElementById('inputTargetUrl');
    const inputTargetRequests = document.getElementById('inputTargetRequests');
    const inputStartTime = document.getElementById('inputStartTime');
    const inputEndTime = document.getElementById('inputEndTime');
    const inputMaxConcurrent = document.getElementById('inputMaxConcurrent');
    const inputTimeoutMs = document.getElementById('inputTimeoutMs');
    const modeDescText = document.getElementById('modeDescText');
    const previewDurationBadge = document.getElementById('previewDurationBadge');
    const modalPreviewBars = document.getElementById('modalPreviewBars');

    // ─── Toast System ─────────────────────────────────────────────────────────────
    function showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        const icons = {
            success: 'fa-circle-check',
            error: 'fa-circle-xmark',
            info: 'fa-circle-info'
        };
        toast.innerHTML = `<i class="fa-solid ${icons[type] || 'fa-info'}"></i><span>${message}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(30px)';
            toast.style.transition = 'all 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    // ─── Format Helpers ───────────────────────────────────────────────────────────
    function formatDateTimeLocal(date) {
        const pad = (n) => String(n).padStart(2, '0');
        const y = date.getFullYear();
        const m = pad(date.getMonth() + 1);
        const d = pad(date.getDate());
        const hh = pad(date.getHours());
        const mm = pad(date.getMinutes());
        return `${y}-${m}-${d}T${hh}:${mm}`;
    }

    // ─── Socket & Polling Events ─────────────────────────────────────────────────
    if (socket) {
        socket.on('connect', () => {
            wsStatus.classList.remove('offline');
            wsStatus.querySelector('.status-label').textContent = 'Kết nối Live';
        });

        socket.on('disconnect', () => {
            wsStatus.classList.add('offline');
            wsStatus.querySelector('.status-label').textContent = 'Mất kết nối';
        });

        socket.on('campaigns-list', (list) => {
            campaigns = list || [];
            renderCampaignsList();
            updateGlobalMetrics();
        });

        socket.on('stats-update', (stats) => {
            updateCampaignCardStats(stats);
            updateGlobalMetrics();
        });

        socket.on('log', (logObj) => {
            appendLogEntry(logObj);
        });
    } else {
        // Cloudflare Worker / Serverless polling mode
        wsStatus.classList.remove('offline');
        wsStatus.querySelector('.status-label').textContent = 'Cloudflare Live Sync';

        let lastSeenLogs = new Set();
        setInterval(async () => {
            await loadCampaigns(true);
            campaigns.forEach(c => {
                if (Array.isArray(c.recentLogs)) {
                    c.recentLogs.forEach(entry => {
                        const key = `${entry.timestamp}_${entry.text}`;
                        if (!lastSeenLogs.has(key)) {
                            lastSeenLogs.add(key);
                            appendLogEntry({
                                campaignId: c.id,
                                campaignName: c.name,
                                ...entry
                            });
                        }
                    });
                }
            });
            if (lastSeenLogs.size > 200) {
                lastSeenLogs = new Set(Array.from(lastSeenLogs).slice(-100));
            }
        }, 2500);
    }

    // ─── Fetch Campaigns on Load ──────────────────────────────────────────────────
    async function loadCampaigns() {
        try {
            const res = await fetch('/api/campaigns');
            const data = await res.json();
            if (data.success) {
                campaigns = data.data || [];
                renderCampaignsList();
                updateGlobalMetrics();
                if (campaigns.length > 0 && !selectedCampaignId) {
                    selectCampaignForChart(campaigns[0].id);
                }
            }
        } catch (e) {
            console.error('Lỗi tải danh sách chiến dịch:', e);
        }
    }

    // ─── Global Metrics ───────────────────────────────────────────────────────────
    function updateGlobalMetrics() {
        globalTotalCampaigns.textContent = campaigns.length;
        const running = campaigns.filter(c => c.status === 'running').length;
        globalRunningCampaigns.textContent = running;
        const totalSuccess = campaigns.reduce((acc, c) => acc + (c.successRequests || 0), 0);
        globalSuccessRequests.textContent = totalSuccess.toLocaleString('vi-VN');
        const totalDispatched = campaigns.reduce((acc, c) => acc + (c.totalDispatched || (c.successRequests || 0) + (c.failedRequests || 0)), 0);
        if (globalTotalDispatched) globalTotalDispatched.textContent = totalDispatched.toLocaleString('vi-VN');
        campaignCountBadge.textContent = `${campaigns.length} chiến dịch`;
    }

    // ─── Render Campaign Cards ────────────────────────────────────────────────────
    function renderCampaignsList() {
        if (!campaignsContainer) return;

        if (campaigns.length === 0) {
            campaignsContainer.innerHTML = '';
            campaignsContainer.appendChild(emptyCampaignsState);
            emptyCampaignsState.style.display = 'flex';
            return;
        }

        emptyCampaignsState.style.display = 'none';
        campaignsContainer.innerHTML = '';

        campaigns.forEach(c => {
            const card = document.createElement('div');
            card.className = `campaign-card ${c.id === selectedCampaignId ? 'selected' : ''}`;
            card.id = `card-c-${c.id}`;

            const statusClass = `status-${c.status}`;
            const statusLabels = {
                running: '<i class="fa-solid fa-play"></i> Đang chạy',
                waiting: '<i class="fa-solid fa-clock"></i> Chờ đến giờ',
                paused: '<i class="fa-solid fa-pause"></i> Tạm dừng',
                completed: '<i class="fa-solid fa-check"></i> Hoàn thành',
                expired: '<i class="fa-solid fa-ban"></i> Hết giờ',
                stopped: '<i class="fa-solid fa-stop"></i> Đã dừng'
            };

            const percent = c.progressPercent || 0;
            const remaining = c.remaining !== undefined ? c.remaining : Math.max(0, c.targetRequests - (c.successRequests || 0));

            card.innerHTML = `
                <div class="campaign-header-row">
                    <div class="campaign-title-wrap">
                        <span class="campaign-name" title="${c.name}">${c.name}</span>
                        <span class="mode-badge ${c.scheduleMode}">${c.scheduleMode}</span>
                    </div>
                    <span class="status-tag ${statusClass}" id="status-tag-${c.id}">
                        ${statusLabels[c.status] || c.status}
                    </span>
                </div>

                <div class="campaign-url-row">
                    <i class="fa-solid fa-link"></i>
                    <span>${c.targetUrl}</span>
                </div>

                <div class="progress-container">
                    <div class="progress-header">
                        <span>Tiến độ đạt target: <b id="prog-count-${c.id}">${c.successRequests || 0} / ${c.targetRequests}</b> requests (<span id="prog-dispatched-${c.id}">Tổng gửi: ${c.totalDispatched || 0} HTTP</span>)</span>
                        <span id="prog-pct-${c.id}">${percent}%</span>
                    </div>
                    <div class="progress-track">
                        <div class="progress-fill" id="prog-bar-${c.id}" style="width: ${percent}%;"></div>
                    </div>
                </div>

                <!-- Live Subrequest Telemetry Box -->
                <div class="campaign-telemetry-box">
                    <div class="telemetry-item">
                        <span class="t-label"><i class="fa-solid fa-paper-plane"></i> Tổng HTTP đã gửi:</span>
                        <b class="t-val val-dispatched" id="stat-disp-${c.id}">${c.totalDispatched || 0}</b>
                    </div>
                    <div class="telemetry-item">
                        <span class="t-label"><i class="fa-solid fa-circle-check"></i> Thành công:</span>
                        <b class="t-val val-success" id="stat-succ-${c.id}">${c.successRequests || 0}</b>
                    </div>
                    <div class="telemetry-item">
                        <span class="t-label"><i class="fa-solid fa-circle-xmark"></i> Thất bại:</span>
                        <b class="t-val val-failed" id="stat-fail-${c.id}">${c.failedRequests || 0}</b>
                    </div>
                    <div class="telemetry-item">
                        <span class="t-label"><i class="fa-solid fa-clock-rotate-left"></i> Cron cuối:</span>
                        <b class="t-val" id="stat-cron-${c.id}">${c.lastCronRunText || 'Chờ đợt tới...'}</b>
                    </div>
                    <div class="telemetry-item span-full">
                        <span class="t-label"><i class="fa-solid fa-bolt"></i> Request cuối:</span>
                        <b class="t-val ${c.lastStatusCode && c.lastStatusCode >= 400 ? 'val-failed' : 'val-success'}" id="stat-req-${c.id}">
                            ${c.lastRequestText ? `${c.lastRequestText} (HTTP ${c.lastStatusCode || '--'} • ${c.lastLatencyMs || '--'}ms)` : 'Chưa gửi'}
                        </b>
                        ${c.lastError ? `<span class="telemetry-err">[${c.lastError}]</span>` : ''}
                    </div>
                </div>

                <div class="campaign-stats-pill-grid">
                    <div class="stat-pill">
                        <span class="stat-pill-label">Mục tiêu</span>
                        <span class="stat-pill-val val-target">${c.targetRequests}</span>
                    </div>
                    <div class="stat-pill">
                        <span class="stat-pill-label">Luồng song song</span>
                        <span class="stat-pill-val val-workers" id="stat-workers-${c.id}">${c.maxConcurrent || 3} luồng</span>
                    </div>
                    <div class="stat-pill">
                        <span class="stat-pill-label">Thời gian còn</span>
                        <span class="stat-pill-val" id="meta-time-left-${c.id}">Đang tính...</span>
                    </div>
                    <div class="stat-pill">
                        <span class="stat-pill-label">Nhịp độ ước tính</span>
                        <span class="stat-pill-val" id="meta-pace-${c.id}">-- req/h</span>
                    </div>
                </div>

                <div class="campaign-actions-row">
                    ${c.status === 'running'
                        ? `<button class="btn btn-sm btn-warning btn-pause" data-id="${c.id}"><i class="fa-solid fa-pause"></i> Tạm dừng</button>`
                        : `<button class="btn btn-sm btn-success btn-start" data-id="${c.id}"><i class="fa-solid fa-play"></i> Bắt đầu</button>`
                    }
                    <button class="btn btn-sm btn-secondary btn-reset" data-id="${c.id}" title="Reset số liệu về 0"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                    <button class="btn btn-sm btn-secondary btn-chart" data-id="${c.id}"><i class="fa-solid fa-chart-simple"></i> Biểu đồ</button>
                    <button class="btn btn-sm btn-secondary btn-edit" data-id="${c.id}"><i class="fa-solid fa-pen"></i> Sửa</button>
                    <button class="btn btn-sm btn-danger btn-delete" data-id="${c.id}"><i class="fa-solid fa-trash"></i> Xóa</button>
                </div>
            `;

            // Click card to select
            card.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                selectCampaignForChart(c.id);
            });

            campaignsContainer.appendChild(card);
        });

        attachCardActionListeners();
    }

    // ─── Attach Card Button Events ────────────────────────────────────────────────
    function attachCardActionListeners() {
        document.querySelectorAll('.btn-start').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.id;
                try {
                    const res = await fetch(`/api/campaigns/${id}/start`, { method: 'POST' });
                    const d = await res.json();
                    if (d.success) showToast(`Đã khởi động chiến dịch ${id}`, 'success');
                    else showToast(d.message, 'error');
                } catch (e) { showToast('Lỗi gửi lệnh bắt đầu', 'error'); }
            };
        });

        document.querySelectorAll('.btn-pause').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.id;
                try {
                    const res = await fetch(`/api/campaigns/${id}/pause`, { method: 'POST' });
                    const d = await res.json();
                    if (d.success) showToast(`Đã tạm dừng chiến dịch ${id}`, 'info');
                } catch (e) { showToast('Lỗi gửi lệnh tạm dừng', 'error'); }
            };
        });

        document.querySelectorAll('.btn-reset').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.id;
                if (!confirm(`Bạn có chắc muốn reset lại số liệu chiến dịch ${id}?`)) return;
                try {
                    const res = await fetch(`/api/campaigns/${id}/reset`, { method: 'POST' });
                    const d = await res.json();
                    if (d.success) showToast(`Đã reset tiến trình chiến dịch ${id}`, 'success');
                } catch (e) { showToast('Lỗi reset', 'error'); }
            };
        });

        document.querySelectorAll('.btn-chart').forEach(btn => {
            btn.onclick = () => {
                selectCampaignForChart(btn.dataset.id);
                // Switch to chart tab
                document.querySelector('.monitor-tab-btn[data-tab="tabChart"]').click();
            };
        });

        document.querySelectorAll('.btn-edit').forEach(btn => {
            btn.onclick = () => {
                openEditModal(btn.dataset.id);
            };
        });

        document.querySelectorAll('.btn-delete').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.id;
                if (!confirm(`Xóa hẳn chiến dịch ${id}? Thao tác này không thể hoàn tác.`)) return;
                try {
                    const res = await fetch(`/api/campaigns/${id}`, { method: 'DELETE' });
                    const d = await res.json();
                    if (d.success) {
                        showToast(`Đã xóa chiến dịch ${id}`, 'info');
                        await loadCampaigns();
                        if (typeof pollSystemHealth === 'function') pollSystemHealth();
                    }
                } catch (e) { showToast('Lỗi xóa chiến dịch', 'error'); }
            };
        });
    }

    // ─── Real-time Stats Card Update ──────────────────────────────────────────────
    function updateCampaignCardStats(stats) {
        const id = stats.campaignId;
        const progCount = document.getElementById(`prog-count-${id}`);
        const progPct = document.getElementById(`prog-pct-${id}`);
        const progBar = document.getElementById(`prog-bar-${id}`);
        const statSucc = document.getElementById(`stat-succ-${id}`);
        const statFail = document.getElementById(`stat-fail-${id}`);
        const statRem = document.getElementById(`stat-rem-${id}`);
        const statWorkers = document.getElementById(`stat-workers-${id}`);
        const metaTime = document.getElementById(`meta-time-left-${id}`);
        const metaPace = document.getElementById(`meta-pace-${id}`);

        if (progCount) progCount.textContent = `${stats.success} / ${stats.target}`;
        if (progPct) progPct.textContent = `${stats.progressPercent}%`;
        if (progBar) progBar.style.width = `${stats.progressPercent}%`;
        const progDisp = document.getElementById(`prog-dispatched-${id}`);
        if (progDisp) progDisp.textContent = `Tổng gửi: ${stats.totalDispatched || stats.success} HTTP`;
        if (statSucc) statSucc.textContent = stats.success;
        if (statFail) statFail.textContent = stats.failed;
        const statDisp = document.getElementById(`stat-disp-${id}`);
        if (statDisp) statDisp.textContent = stats.totalDispatched || (stats.success + stats.failed);
        if (statWorkers) statWorkers.textContent = `${stats.activeWorkers} / ${stats.maxConcurrent}`;

        if (metaTime) {
            metaTime.textContent = stats.status === 'running'
                ? `Còn lại: ${stats.timeRemainingStr} (Dự kiến: ${stats.etaStr})`
                : (stats.status === 'completed' ? 'Đã hoàn thành' : stats.status);
        }

        if (metaPace) {
            if (stats.nextIntervalSec > 0) {
                metaPace.textContent = `~${stats.nextIntervalSec}s/req (${stats.currentRatePerHour} req/h)`;
            } else {
                metaPace.textContent = `Tốc độ: ${stats.currentRatePerHour} req/h`;
            }
        }

        if (stats.avgLatencyMs > 0) {
            globalAvgLatency.textContent = `${stats.avgLatencyMs} ms`;
        }

        // Update local object
        const c = campaigns.find(item => item.id == id);
        if (c) {
            c.successRequests = stats.success;
            c.failedRequests = stats.failed;
            c.totalDispatched = stats.totalDispatched || (stats.success + stats.failed);
            c.remaining = stats.remaining;
            c.progressPercent = stats.progressPercent;
            c.status = stats.status;
        }
    }

    // ─── Real-time Log Stream ─────────────────────────────────────────────────────
    function appendLogEntry(log) {
        if (!consoleLogs) return;

        const empty = consoleLogs.querySelector('.console-empty');
        if (empty) empty.remove();

        const row = document.createElement('div');
        row.className = `log-entry log-${log.type || 'info'}`;
        row.innerHTML = `
            <span class="log-time">[${log.timestamp || new Date().toLocaleTimeString('vi-VN')}]</span>
            <span class="log-cid">[C${log.campaignId}]</span>
            <span class="log-msg">${escapeHtml(log.text)}</span>
        `;

        consoleLogs.appendChild(row);

        // Keep maximum 300 logs
        while (consoleLogs.children.length > 300) {
            consoleLogs.removeChild(consoleLogs.firstChild);
        }

        if (autoScrollLogs) {
            consoleLogs.scrollTop = consoleLogs.scrollHeight;
        }
    }

    if (btnClearLogs) {
        btnClearLogs.onclick = () => {
            consoleLogs.innerHTML = '<div class="console-empty">Logs đã được xóa sạch.</div>';
        };
    }

    // ─── Distribution Chart & Visualizer ──────────────────────────────────────────
    function selectCampaignForChart(campaignId) {
        selectedCampaignId = campaignId;

        // Highlight selected card
        document.querySelectorAll('.campaign-card').forEach(card => card.classList.remove('selected'));
        const selectedCard = document.getElementById(`card-c-${campaignId}`);
        if (selectedCard) selectedCard.classList.add('selected');

        const c = campaigns.find(item => item.id == campaignId);
        if (!c) return;

        chartCampaignTitle.textContent = `${c.name} - Phân bổ ${c.scheduleMode.toUpperCase()}`;
        chartCampaignSubtitle.textContent = `Tổng ${c.targetRequests} requests • ${new Date(c.startTime).toLocaleString('vi-VN')} → ${new Date(c.endTime).toLocaleString('vi-VN')}`;

        renderDistributionChart({
            startTime: c.startTime,
            endTime: c.endTime,
            targetRequests: c.targetRequests,
            mode: c.scheduleMode,
            timezoneOffsetMinutes: c.config.timezoneOffsetMinutes || (new Date().getTimezoneOffset())
        });
    }

    function renderDistributionChart(params) {
        if (!window.buildTimeDistribution) return;

        const dist = window.buildTimeDistribution({
            startTime: params.startTime,
            endTime: params.endTime,
            targetClicks: params.targetRequests,
            mode: params.mode,
            timezoneOffsetMinutes: params.timezoneOffsetMinutes
        });

        if (!dist.valid || dist.slices.length === 0) {
            chartBarsWrap.innerHTML = '<div class="text-muted" style="margin:auto;">Không thể tính toán khoảng thời gian</div>';
            chartSummaryBlocks.innerHTML = '';
            return;
        }

        // Render summary blocks
        chartSummaryBlocks.innerHTML = '';
        dist.summaryBlocks.forEach(b => {
            const chip = document.createElement('div');
            chip.className = 'summary-chip';
            chip.style.background = `${b.color}20`;
            chip.style.border = `1px solid ${b.color}50`;
            chip.style.color = b.color;
            chip.innerHTML = `<span>${b.label}</span> <b>${b.quota} reqs (${b.percent}%)</b>`;
            chartSummaryBlocks.appendChild(chip);
        });

        // Render Bars
        chartBarsWrap.innerHTML = '';
        const maxQuota = Math.max(...dist.slices.map(s => s.quota), 1);

        dist.slices.forEach(s => {
            const col = document.createElement('div');
            col.className = 'chart-col';

            const heightPct = Math.max(4, Math.round((s.quota / maxQuota) * 100));

            col.innerHTML = `
                <div class="chart-bar" style="height: ${heightPct}%;" title="${s.startStr} - ${s.endStr}: ${s.quota} reqs (${s.percent}%)">
                    <span class="chart-bar-val">${s.quota}</span>
                </div>
                <span class="chart-hour-label">${s.startStr}</span>
            `;

            chartBarsWrap.appendChild(col);
        });
    }

    // ─── Modal & Form Management ──────────────────────────────────────────────────
    function openCreateModal() {
        modalTitle.innerHTML = '<i class="fa-solid fa-sliders"></i> Tạo chiến dịch mới';
        editCampaignId.value = '';
        inputName.value = `Test ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
        inputTargetUrl.value = 'https://uanbidvak.com';
        inputTargetRequests.value = 750;
        inputMaxConcurrent.value = 3;
        inputTimeoutMs.value = 8000;
        pingResult.innerHTML = '';

        // Default 6 hours duration
        const now = new Date();
        const end = new Date(now.getTime() + 6 * 3600000);
        inputStartTime.value = formatDateTimeLocal(now);
        inputEndTime.value = formatDateTimeLocal(end);

        document.querySelector('input[name="scheduleMode"][value="smart"]').checked = true;
        updateModeDesc();
        updateModalPreview();

        campaignModal.classList.add('active');
    }

    function openEditModal(campaignId) {
        const c = campaigns.find(item => item.id == campaignId);
        if (!c) return;

        modalTitle.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Chỉnh sửa chiến dịch ${campaignId}`;
        editCampaignId.value = campaignId;
        inputName.value = c.name;
        inputTargetUrl.value = c.targetUrl;
        inputTargetRequests.value = c.targetRequests;
        inputMaxConcurrent.value = c.maxConcurrent || 3;
        inputTimeoutMs.value = c.timeoutMs || 8000;
        pingResult.innerHTML = '';

        inputStartTime.value = formatDateTimeLocal(new Date(c.startTime));
        inputEndTime.value = formatDateTimeLocal(new Date(c.endTime));

        const modeRadio = document.querySelector(`input[name="scheduleMode"][value="${c.scheduleMode}"]`);
        if (modeRadio) modeRadio.checked = true;

        updateModeDesc();
        updateModalPreview();

        campaignModal.classList.add('active');
    }

    function closeModal() {
        campaignModal.classList.remove('active');
    }

    if (btnOpenCreateModal) btnOpenCreateModal.onclick = openCreateModal;
    if (btnEmptyCreate) btnEmptyCreate.onclick = openCreateModal;
    if (btnCloseModal) btnCloseModal.onclick = closeModal;
    if (btnCancelModal) btnCancelModal.onclick = closeModal;

    // Mode description update
    function updateModeDesc() {
        const mode = document.querySelector('input[name="scheduleMode"]:checked')?.value || 'smart';
        if (mode === 'smart') {
            modeDescText.textContent = 'SMART: Ít lúc sáng sớm → Tăng dần → Cao điểm trưa & chiều → Tự động tính toán lại nhịp nếu server bị lag (Adaptive Pacing).';
        } else {
            modeDescText.textContent = 'EVEN: Chia đều số requests suốt toàn bộ khoảng thời gian, giữ khoảng cách các requests ổn định.';
        }
        updateModalPreview();
    }

    document.querySelectorAll('input[name="scheduleMode"]').forEach(r => {
        r.addEventListener('change', updateModeDesc);
    });

    // Preset Durations
    document.querySelectorAll('.btn-preset').forEach(btn => {
        btn.onclick = () => {
            const hours = parseFloat(btn.dataset.hours);
            const start = new Date(inputStartTime.value || Date.now());
            const end = new Date(start.getTime() + hours * 3600000);
            inputEndTime.value = formatDateTimeLocal(end);
            updateModalPreview();
        };
    });

    // Form inputs change triggers live preview
    [inputStartTime, inputEndTime, inputTargetRequests].forEach(input => {
        input.addEventListener('input', updateModalPreview);
    });

    function updateModalPreview() {
        if (!window.buildTimeDistribution) return;

        const start = new Date(inputStartTime.value).getTime();
        const end = new Date(inputEndTime.value).getTime();
        const count = parseInt(inputTargetRequests.value, 10) || 0;
        const mode = document.querySelector('input[name="scheduleMode"]:checked')?.value || 'smart';

        if (isNaN(start) || isNaN(end) || end <= start || count <= 0) {
            previewDurationBadge.textContent = '0 giờ';
            modalPreviewBars.innerHTML = '';
            return;
        }

        const dist = window.buildTimeDistribution({
            startTime: start,
            endTime: end,
            targetClicks: count,
            mode,
            timezoneOffsetMinutes: new Date().getTimezoneOffset()
        });

        previewDurationBadge.textContent = dist.durationFormatted;
        modalPreviewBars.innerHTML = '';

        if (!dist.valid || dist.slices.length === 0) return;

        const maxQ = Math.max(...dist.slices.map(s => s.quota), 1);
        dist.slices.forEach(s => {
            const col = document.createElement('div');
            col.className = 'preview-col';
            const h = Math.max(4, Math.round((s.quota / maxQ) * 100));
            col.innerHTML = `<div class="preview-bar" style="height: ${h}%;" title="${s.startStr}-${s.endStr}: ${s.quota}"></div>`;
            modalPreviewBars.appendChild(col);
        });
    }

    // ─── Test URL Ping ────────────────────────────────────────────────────────────
    if (btnTestUrl) {
        btnTestUrl.onclick = async () => {
            const url = inputTargetUrl.value.trim();
            if (!url) {
                pingResult.className = 'ping-result error';
                pingResult.textContent = 'Vui lòng nhập URL hợp lệ trước';
                return;
            }

            btnTestUrl.disabled = true;
            btnTestUrl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang test...';
            pingResult.className = 'ping-result';
            pingResult.textContent = 'Đang kiểm tra kết nối...';

            try {
                const res = await fetch('/api/test-url', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, timeoutMs: 6000 })
                });
                const d = await res.json();

                if (d.success) {
                    pingResult.className = 'ping-result success';
                    pingResult.innerHTML = `<i class="fa-solid fa-circle-check"></i> Kết nối thành công (HTTP ${d.statusCode}, ${d.latencyMs}ms)`;
                } else {
                    pingResult.className = 'ping-result error';
                    pingResult.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Không kết nối được: ${d.error || `HTTP ${d.statusCode}`} (${d.latencyMs}ms)`;
                }
            } catch (err) {
                pingResult.className = 'ping-result error';
                pingResult.textContent = `Lỗi mạng khi test: ${err.message}`;
            } finally {
                btnTestUrl.disabled = false;
                btnTestUrl.innerHTML = '<i class="fa-solid fa-plug"></i> Test Ping';
            }
        };
    }

    // ─── Form Submission (Create or Edit) ─────────────────────────────────────────
    if (campaignForm) {
        campaignForm.onsubmit = async (e) => {
            e.preventDefault();

            const startMs = new Date(inputStartTime.value).getTime();
            const endMs = new Date(inputEndTime.value).getTime();

            if (endMs <= startMs) {
                alert('Thời điểm kết thúc phải sau thời điểm bắt đầu!');
                return;
            }

            const payload = {
                name: inputName.value.trim(),
                targetUrl: inputTargetUrl.value.trim(),
                targetRequests: parseInt(inputTargetRequests.value, 10),
                scheduleMode: document.querySelector('input[name="scheduleMode"]:checked').value,
                startTime: startMs,
                endTime: endMs,
                maxConcurrent: parseInt(inputMaxConcurrent.value, 10) || 3,
                timeoutMs: parseInt(inputTimeoutMs.value, 10) || 8000,
                timezoneOffsetMinutes: new Date().getTimezoneOffset()
            };

            const isEdit = Boolean(editCampaignId.value);
            const url = isEdit ? `/api/campaigns/${editCampaignId.value}` : '/api/campaigns';
            const method = isEdit ? 'PUT' : 'POST';

            try {
                const res = await fetch(url, {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const d = await res.json();

                if (d.success) {
                    showToast(isEdit ? 'Đã cập nhật chiến dịch!' : 'Đã tạo chiến dịch thành công!', 'success');
                    closeModal();
                    loadCampaigns();
                } else {
                    alert(`Lỗi: ${d.message}`);
                }
            } catch (err) {
                alert(`Lỗi hệ thống: ${err.message}`);
            }
        };
    }

    // ─── Monitor Section Tab Switching ────────────────────────────────────────────
    document.querySelectorAll('.monitor-tab-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.monitor-tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.monitor-tab-content').forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            const target = document.getElementById(btn.dataset.tab);
            if (target) target.classList.add('active');

            if (btn.dataset.tab === 'tabChart' && selectedCampaignId) {
                selectCampaignForChart(selectedCampaignId);
            }
        };
    });

    // ─── Helpers ──────────────────────────────────────────────────────────────────
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ─── Sample Campaign Creator ──────────────────────────────────────────────────
    async function createSampleCampaign() {
        try {
            const res = await fetch('/api/campaigns/sample', { method: 'POST' });
            const d = await res.json();
            if (d.success) {
                showToast('Đã tạo chiến dịch mẫu hôm nay thành công!', 'success');
                await loadCampaigns();
                pollSystemHealth();
            } else {
                showToast(d.message || 'Lỗi tạo chiến dịch mẫu', 'error');
            }
        } catch (e) {
            showToast('Lỗi gửi request tạo mẫu', 'error');
        }
    }

    const btnQuickSample = document.getElementById('btnQuickSample');
    if (btnQuickSample) btnQuickSample.onclick = createSampleCampaign;

    const btnEmptySample = document.getElementById('btnEmptySample');
    if (btnEmptySample) btnEmptySample.onclick = createSampleCampaign;

    // ─── System Health & Cron Polling ─────────────────────────────────────────────
    async function pollSystemHealth() {
        try {
            const res = await fetch('/api/health');
            if (!res.ok) return;
            const data = await res.json();

            const healthWorkerVal = document.getElementById('healthWorkerVal');
            const healthCronVal = document.getElementById('healthCronVal');
            const healthCronDot = document.getElementById('healthCronDot');
            const healthStorageVal = document.getElementById('healthStorageVal');
            const healthStorageDot = document.getElementById('healthStorageDot');
            const healthSchedulerVal = document.getElementById('healthSchedulerVal');
            const healthSchedulerDot = document.getElementById('healthSchedulerDot');
            const healthServerTimeVal = document.getElementById('healthServerTimeVal');

            if (healthWorkerVal) healthWorkerVal.textContent = '🟢 Online';
            if (healthServerTimeVal && data.serverTimeText) healthServerTimeVal.textContent = data.serverTimeText;

            // Cron status
            if (healthCronVal && healthCronDot) {
                if (data.cronStatus === 'never' || !data.lastCronRun) {
                    healthCronVal.textContent = '🔴 Chưa chạy (Never)';
                    healthCronVal.className = 'chip-val status-val-never';
                    healthCronDot.className = 'pulse-indicator offline';
                } else if (data.cronStatus === 'active') {
                    const ago = data.cronSecondsAgo !== null ? `${data.cronSecondsAgo}s trước` : '';
                    healthCronVal.textContent = `🟢 ${data.lastCronRunText} (${ago})`;
                    healthCronVal.className = 'chip-val status-val-ok';
                    healthCronDot.className = 'pulse-indicator online';
                } else {
                    healthCronVal.textContent = `🟡 ${data.lastCronRunText} (${data.cronSecondsAgo}s trước)`;
                    healthCronVal.className = 'chip-val status-val-warn';
                    healthCronDot.className = 'pulse-indicator waiting';
                }
            }

            // Storage status
            if (healthStorageVal && healthStorageDot) {
                if (data.storage === 'connected') {
                    healthStorageVal.textContent = '🟢 KV Connected';
                    healthStorageDot.className = 'pulse-indicator online';
                } else {
                    healthStorageVal.textContent = '🟡 Memory fallback';
                    healthStorageDot.className = 'pulse-indicator waiting';
                }
            }

            // Scheduler status
            if (healthSchedulerVal && healthSchedulerDot) {
                if (data.runningCampaigns > 0) {
                    healthSchedulerVal.textContent = `🟢 Active (${data.runningCampaigns} đang chạy)`;
                    healthSchedulerDot.className = 'pulse-indicator online';
                } else {
                    healthSchedulerVal.textContent = `⚪ Idle (0 đang chạy)`;
                    healthSchedulerDot.className = 'pulse-indicator idle';
                }
            }
        } catch (e) {
            console.warn('Lỗi kiểm tra health:', e);
        }
    }

    // Initialize
    loadCampaigns();
    pollSystemHealth();
    setInterval(pollSystemHealth, 5000);
});
