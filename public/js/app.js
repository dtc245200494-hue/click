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

    // New decoupled features
    const modalLockedBanner = document.getElementById('modalLockedBanner');
    const inputProxyEnabled = document.getElementById('inputProxyEnabled');
    const proxyFieldsWrap = document.getElementById('proxyFieldsWrap');
    const proxyFreeWarning = document.getElementById('proxyFreeWarning');
    const inputProxyGateways = document.getElementById('inputProxyGateways');
    const inputProxyInterval = document.getElementById('inputProxyInterval');
    const execModeHint = document.getElementById('execModeHint');

    // Scenario Engine Elements
    const scenarioGroup = document.getElementById('scenarioGroup');
    const scenarioStepsContainer = document.getElementById('scenarioStepsContainer');
    const btnAddScenarioStep = document.getElementById('btnAddScenarioStep');
    const screenshotModal = document.getElementById('screenshotModal');
    const screenshotImg = document.getElementById('screenshotImg');
    const btnCloseScreenshotModal = document.getElementById('btnCloseScreenshotModal');

    let currentScenarioSteps = [
        { action: 'waitForSelector', selector: 'body', timeout: 5000 }
    ];

    function updateProxyWarningVisibility() {
        const mode = document.querySelector('input[name="executionMode"]:checked')?.value || 'browser';
        const isProxy = Boolean(inputProxyEnabled && inputProxyEnabled.checked);
        if (proxyFreeWarning) {
            proxyFreeWarning.style.display = (mode === 'browser' && isProxy) ? 'block' : 'none';
        }
        if (scenarioGroup) {
            scenarioGroup.style.display = (mode === 'browser') ? 'block' : 'none';
        }
    }

    if (inputProxyEnabled) {
        inputProxyEnabled.addEventListener('change', () => {
            if (proxyFieldsWrap) proxyFieldsWrap.style.display = inputProxyEnabled.checked ? 'block' : 'none';
            updateProxyWarningVisibility();
        });
    }

    document.querySelectorAll('input[name="executionMode"]').forEach(r => {
        r.addEventListener('change', () => {
            const mode = document.querySelector('input[name="executionMode"]:checked')?.value || 'browser';
            if (execModeHint) {
                execModeHint.textContent = mode === 'browser'
                    ? 'Browser QA: Render DOM/JS thật bằng Browserless.io Chromium. Rất tự nhiên, lấy title và bắt chước phiên người dùng.'
                    : 'HTTP: Subrequest Cloudflare fetch() tốc độ cao, siêu nhẹ cho kiểm thử tải lớn.';
            }
            updateProxyWarningVisibility();
        });
    });

    function renderScenarioSteps() {
        if (!scenarioStepsContainer) return;
        scenarioStepsContainer.innerHTML = '';
        currentScenarioSteps.forEach((step, idx) => {
            const item = document.createElement('div');
            item.className = 'scenario-step-item';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '8px';
            item.style.padding = '8px 12px';
            item.style.background = 'rgba(255, 255, 255, 0.04)';
            item.style.border = '1px solid var(--border-color)';
            item.style.borderRadius = 'var(--radius-sm)';

            let fieldsHtml = '';
            if (step.action === 'waitForSelector') {
                fieldsHtml = `
                    <input type="text" class="step-selector" placeholder="CSS Selector (VD: #content, .btn-login)" value="${escapeHtml(step.selector || '')}" style="flex: 2; padding: 4px 8px; font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;">
                    <input type="number" class="step-timeout" placeholder="Timeout ms" value="${step.timeout || 5000}" style="width: 80px; padding: 4px 8px; font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;">
                `;
            } else if (step.action === 'click') {
                fieldsHtml = `
                    <input type="text" class="step-selector" placeholder="Selector để Click (VD: button.submit, a.nav)" value="${escapeHtml(step.selector || '')}" style="flex: 2; padding: 4px 8px; font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;">
                `;
            } else if (step.action === 'type') {
                fieldsHtml = `
                    <input type="text" class="step-selector" placeholder="Input Selector (VD: input#username)" value="${escapeHtml(step.selector || '')}" style="flex: 1.5; padding: 4px 8px; font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;">
                    <input type="text" class="step-value" placeholder="Giá trị cần nhập" value="${escapeHtml(step.value || '')}" style="flex: 1.5; padding: 4px 8px; font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;">
                `;
            } else if (step.action === 'assertText') {
                fieldsHtml = `
                    <input type="text" class="step-selector" placeholder="Selector chứa chữ (VD: h1, .welcome-msg)" value="${escapeHtml(step.selector || '')}" style="flex: 1.5; padding: 4px 8px; font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;">
                    <input type="text" class="step-expected" placeholder="Nội dung mong đợi" value="${escapeHtml(step.expected || '')}" style="flex: 1.5; padding: 4px 8px; font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;">
                `;
            } else if (step.action === 'wait') {
                fieldsHtml = `
                    <input type="number" class="step-duration" placeholder="Thời gian chờ ms (VD: 2000)" value="${step.duration || 1000}" min="100" max="10000" style="flex: 1; padding: 4px 8px; font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;">
                `;
            }

            item.innerHTML = `
                <span style="font-size: 11px; opacity: 0.7; min-width: 20px;">#${idx + 1}</span>
                <select class="step-action-select" style="padding: 4px 8px; font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 4px; color: #fff;">
                    <option value="waitForSelector" ${step.action === 'waitForSelector' ? 'selected' : ''}>Chờ selector</option>
                    <option value="click" ${step.action === 'click' ? 'selected' : ''}>Click selector</option>
                    <option value="type" ${step.action === 'type' ? 'selected' : ''}>Nhập text</option>
                    <option value="assertText" ${step.action === 'assertText' ? 'selected' : ''}>Kiểm tra text</option>
                    <option value="wait" ${step.action === 'wait' ? 'selected' : ''}>Chờ độ trễ (delay)</option>
                </select>
                ${fieldsHtml}
                <button type="button" class="btn-remove-step btn-icon" style="color: #ef4444; width: 24px; height: 24px; min-width: 24px; padding: 0;" title="Xóa bước này">
                    <i class="fa-solid fa-trash-can" style="font-size: 12px;"></i>
                </button>
            `;

            const selectEl = item.querySelector('.step-action-select');
            selectEl.onchange = (e) => {
                step.action = e.target.value;
                renderScenarioSteps();
            };

            const selInput = item.querySelector('.step-selector');
            if (selInput) selInput.oninput = (e) => { step.selector = e.target.value; };
            const valInput = item.querySelector('.step-value');
            if (valInput) valInput.oninput = (e) => { step.value = e.target.value; };
            const expInput = item.querySelector('.step-expected');
            if (expInput) expInput.oninput = (e) => { step.expected = e.target.value; };
            const timeInput = item.querySelector('.step-timeout');
            if (timeInput) timeInput.oninput = (e) => { step.timeout = parseInt(e.target.value, 10) || 5000; };
            const durInput = item.querySelector('.step-duration');
            if (durInput) durInput.oninput = (e) => { step.duration = parseInt(e.target.value, 10) || 1000; };

            const removeBtn = item.querySelector('.btn-remove-step');
            if (removeBtn) {
                removeBtn.onclick = () => {
                    currentScenarioSteps.splice(idx, 1);
                    renderScenarioSteps();
                };
            }

            scenarioStepsContainer.appendChild(item);
        });
    }

    if (btnAddScenarioStep) {
        btnAddScenarioStep.onclick = () => {
            currentScenarioSteps.push({ action: 'waitForSelector', selector: '', timeout: 5000 });
            renderScenarioSteps();
        };
    }

    if (btnCloseScreenshotModal) {
        btnCloseScreenshotModal.onclick = () => {
            if (screenshotModal) screenshotModal.style.display = 'none';
        };
    }
    if (screenshotModal) {
        screenshotModal.onclick = (e) => {
            if (e.target === screenshotModal) screenshotModal.style.display = 'none';
        };
    }

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

    // ─── Button Matrix & Actions Helper ──────────────────────────────────────────
    function renderCampaignActionButtons(c) {
        const status = c.status || 'waiting';
        let buttonsHtml = '';
        let lockHintHtml = '';

        const btnStart = `<button class="btn btn-sm btn-success btn-start" data-id="${c.id}" title="Khởi chạy chiến dịch"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Bắt đầu</button>`;
        const btnPause = `<button class="btn btn-sm btn-warning btn-pause" data-id="${c.id}" title="Tạm dừng"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Tạm dừng</button>`;
        const btnResume = `<button class="btn btn-sm btn-success btn-resume" data-id="${c.id}" title="Tiếp tục chạy"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Tiếp tục</button>`;
        const btnStop = `<button class="btn btn-sm btn-danger btn-stop" data-id="${c.id}" title="Dừng chiến dịch"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg> Dừng</button>`;
        const btnReset = `<button class="btn btn-sm btn-secondary btn-reset" data-id="${c.id}" title="Reset số liệu về 0 & Mở khóa cấu hình"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Reset</button>`;
        const btnClone = `<button class="btn btn-sm btn-primary-glass btn-clone" data-id="${c.id}" title="Nhân bản cấu hình sang chiến dịch mới"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Nhân bản</button>`;
        const btnChart = `<button class="btn btn-sm btn-secondary btn-chart" data-id="${c.id}" title="Xem biểu đồ"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> Biểu đồ</button>`;
        const btnEdit = `<button class="btn btn-sm btn-secondary btn-edit" data-id="${c.id}" title="Chỉnh sửa"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Sửa</button>`;
        const btnDelete = `<button class="btn btn-sm btn-danger btn-delete" data-id="${c.id}" title="Xóa"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Xóa</button>`;

        if (status === 'running') {
            buttonsHtml = `${btnPause} ${btnStop} ${btnChart}`;
            lockHintHtml = `<div class="lock-status-hint running"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> 🔒 Đang chạy - cấu hình đã khóa</div>`;
        } else if (status === 'paused') {
            buttonsHtml = `${btnResume} ${btnStop} ${btnChart}`;
            lockHintHtml = `<div class="lock-status-hint paused"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> 🔒 Đang tạm dừng - cấu hình vẫn khóa</div>`;
        } else if (status === 'stopped') {
            buttonsHtml = `${btnReset} ${btnClone} ${btnChart} ${btnDelete}`;
        } else if (status === 'completed' || status === 'expired') {
            buttonsHtml = `${btnClone} ${btnChart} ${btnDelete}`;
        } else {
            // waiting (chưa chạy)
            buttonsHtml = `${btnStart} ${btnEdit} ${btnChart} ${btnDelete}`;
        }

        return { buttonsHtml, lockHintHtml };
    }

    function cloneCampaignToModal(campaignId) {
        const c = campaigns.find(item => String(item.id) === String(campaignId));
        if (!c) return;

        openCreateModal(); // Resets modal to create mode (editCampaignId = '')
        modalTitle.innerHTML = `<i class="fa-solid fa-copy"></i> Nhân bản chiến dịch ${campaignId}`;
        
        // Fill values from source campaign
        inputName.value = `[Clone] ${c.name || 'Chiến dịch'}`;
        inputTargetUrl.value = c.targetUrl || 'https://example.com';
        inputTargetRequests.value = c.targetRequests || 100;
        inputMaxConcurrent.value = c.maxConcurrent || 2;
        inputTimeoutMs.value = c.timeoutMs || 15000;

        // Schedule new times: start = now, end = now + (c.endTime - c.startTime) or 2 hours
        const origDuration = (c.endTime && c.startTime && c.endTime > c.startTime) 
            ? (c.endTime - c.startTime) 
            : 2 * 3600000;
        const now = new Date();
        const end = new Date(now.getTime() + origDuration);
        inputStartTime.value = formatDateTimeLocal(now);
        inputEndTime.value = formatDateTimeLocal(end);

        const modeRadio = document.querySelector(`input[name="scheduleMode"][value="${c.scheduleMode || 'smart'}"]`);
        if (modeRadio) modeRadio.checked = true;

        const execRadio = document.querySelector(`input[name="executionMode"][value="${c.executionMode || 'browser'}"]`);
        if (execRadio) execRadio.checked = true;

        if (inputProxyEnabled) {
            inputProxyEnabled.checked = Boolean(c.proxyConfig?.enabled);
            if (proxyFieldsWrap) proxyFieldsWrap.style.display = c.proxyConfig?.enabled ? 'block' : 'none';
        }
        if (inputProxyGateways) {
            inputProxyGateways.value = Array.isArray(c.proxyConfig?.gateways) ? c.proxyConfig.gateways.join('\n') : '';
        }
        if (inputProxyInterval) {
            inputProxyInterval.value = c.proxyConfig?.rotationIntervalSec || 300;
        }

        // Clone scenario steps if available
        if (Array.isArray(c.scenario) && c.scenario.length > 0) {
            currentScenarioSteps = JSON.parse(JSON.stringify(c.scenario.filter(s => s.action !== 'goto')));
            if (currentScenarioSteps.length === 0) {
                currentScenarioSteps = [{ action: 'waitForSelector', selector: 'body', timeout: 5000 }];
            }
        } else {
            currentScenarioSteps = [{ action: 'waitForSelector', selector: 'body', timeout: 5000 }];
        }
        renderScenarioSteps();
        updateProxyWarningVisibility();

        // Clone creates a new campaign so all fields are unlocked
        if (modalLockedBanner) modalLockedBanner.style.display = 'none';
        setFormInputsDisabled(false);

        updateModeDesc();
        updateModalPreview();
        showToast(`Đã sao chép cấu hình từ chiến dịch ${campaignId}. Bạn có thể chỉnh sửa trước khi lưu.`, 'info');
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
                running: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Đang chạy',
                waiting: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Chờ đến giờ',
                paused: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Tạm dừng',
                completed: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Hoàn thành',
                expired: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> Hết giờ',
                stopped: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16"/></svg> Đã dừng'
            };

            const percent = c.progressPercent || 0;
            const remaining = c.remaining !== undefined ? c.remaining : Math.max(0, c.targetRequests - (c.successRequests || 0));
            const isBrowser = (c.executionMode === 'browser');
            const hasStarted = Boolean(c.hasStarted);
            const proxyEnabled = Boolean(c.proxyConfig && c.proxyConfig.enabled);
            const { buttonsHtml, lockHintHtml } = renderCampaignActionButtons(c);

            card.innerHTML = `
                <div class="campaign-header-row">
                    <div class="campaign-title-wrap">
                        <span class="campaign-name" title="${c.name}">${c.name}</span>
                        <span class="mode-badge ${c.scheduleMode}">${c.scheduleMode}</span>
                        <span class="mode-badge ${isBrowser ? 'browser' : 'http'}">
                            ${isBrowser
                                ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Browser QA'
                                : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> HTTP'
                            }
                        </span>
                        ${hasStarted ? '<span class="badge-locked" title="Chiến dịch đã chạy - Các thông số cốt lõi đã bị khóa an toàn"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Locked</span>' : ''}
                    </div>
                    <span class="status-tag ${statusClass}" id="status-tag-${c.id}">
                        ${statusLabels[c.status] || c.status}
                    </span>
                </div>

                <div class="campaign-url-row">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    <span>${c.targetUrl}</span>
                </div>

                ${proxyEnabled ? `
                <div class="campaign-proxy-row">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
                    <span>Proxy: <strong>${c.lastGateway ? c.lastGateway.replace(/:\/\/[^@]*@/, '://***@') : (c.proxyConfig.currentGateway ? c.proxyConfig.currentGateway.replace(/:\/\/[^@]*@/, '://***@') : 'Đang khởi tạo...')}</strong></span>
                    <span style="opacity: 0.7; font-size: 11px;">(Xoay mỗi ${c.proxyConfig.rotationIntervalSec || 300}s)</span>
                </div>
                ` : ''}

                <div class="progress-container">
                    <div class="progress-header">
                        <span>Tiến độ đạt target: <b id="prog-count-${c.id}">${c.successRequests || 0} / ${c.targetRequests}</b> requests (<span id="prog-dispatched-${c.id}">Tổng gửi: ${c.totalDispatched || 0} ${isBrowser ? 'Browsers' : 'HTTP'}</span>)</span>
                        <span id="prog-pct-${c.id}">${percent}%</span>
                    </div>
                    <div class="progress-track">
                        <div class="progress-fill" id="prog-bar-${c.id}" style="width: ${percent}%;"></div>
                    </div>
                </div>

                <!-- Live Subrequest Telemetry Box -->
                <div class="campaign-telemetry-box">
                    <div class="telemetry-item">
                        <span class="t-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Tổng ${isBrowser ? 'Browser Runs' : 'HTTP'}:</span>
                        <b class="t-val val-dispatched" id="stat-disp-${c.id}">${c.totalDispatched || 0}</b>
                    </div>
                    <div class="telemetry-item">
                        <span class="t-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg> Sequence:</span>
                        <b class="t-val">#${c.jobSequence || 0}</b>
                    </div>
                    <div class="telemetry-item">
                        <span class="t-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg> Thành công:</span>
                        <b class="t-val val-success" id="stat-succ-${c.id}">${c.successRequests || 0}</b>
                    </div>
                    <div class="telemetry-item">
                        <span class="t-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> Thất bại:</span>
                        <b class="t-val val-failed" id="stat-fail-${c.id}">${c.failedRequests || 0}</b>
                    </div>
                    <div class="telemetry-item">
                        <span class="t-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Lần chạy cuối:</span>
                        <b class="t-val" id="stat-cron-${c.id}">${c.lastAlarmRunText || c.lastCronRunText || 'Chờ đợt tới...'}</b>
                    </div>
                    <div class="telemetry-item">
                        <span class="t-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> S2S Lag:</span>
                        <b class="t-val ${c.schedulerLagMs > 500 ? 'val-failed' : 'val-success'}">${c.schedulerLagMs ? `+${c.schedulerLagMs}ms` : '0ms (Chuẩn)'}</b>
                    </div>
                    <div class="telemetry-item span-full">
                        <span class="t-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Kết quả cuối:</span>
                        <b class="t-val ${c.lastStatusCode && c.lastStatusCode >= 400 ? 'val-failed' : 'val-success'}" id="stat-req-${c.id}">
                            ${c.lastRequestText ? `${c.lastRequestText} (HTTP ${c.lastStatusCode || '--'} • ${c.lastLatencyMs || '--'}ms)` : 'Chưa gửi'}
                        </b>
                        ${c.lastError ? `<span class="telemetry-err">[${c.lastError}]</span>` : ''}
                    </div>
                    ${(isBrowser && c.lastPageTitle) ? `
                    <div class="telemetry-item span-full item-page-title">
                        <span class="t-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> DOM Title:</span>
                        <b class="t-val" style="word-break: break-all; font-weight: 500;">"${escapeHtml(c.lastPageTitle)}"</b>
                    </div>
                    ` : ''}
                    ${(isBrowser && c.lastStepLogs && c.lastStepLogs.length > 0) ? `
                    <div class="telemetry-item span-full">
                        <span class="t-label"><i class="fa-solid fa-list-check"></i> Kịch bản DOM:</span>
                        <span style="font-size: 11px; color: var(--text-muted);">${c.lastStepLogs.map(s => `[#${s.step} ${s.action}: ${s.status}]`).join(' → ')}</span>
                    </div>
                    ` : ''}
                    ${(isBrowser && c.lastErrorScreenshot) ? `
                    <div class="telemetry-item span-full" style="display: flex; align-items: center; justify-content: space-between; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: var(--radius-sm); padding: 6px 10px;">
                        <span class="t-label" style="color: #fca5a5;"><i class="fa-solid fa-camera"></i> Sự cố Chromium được lưu:</span>
                        <button type="button" class="btn btn-secondary btn-xs btn-view-screenshot" data-img="${c.lastErrorScreenshot}" style="font-size: 11px; padding: 2px 8px; border-color: rgba(239, 68, 68, 0.4); color: #fca5a5;">
                            <i class="fa-solid fa-eye"></i> Xem ảnh lỗi
                        </button>
                    </div>
                    ` : ''}
                </div>

                <div class="campaign-stats-pill-grid">
                    <div class="stat-pill">
                        <span class="stat-pill-label">Mục tiêu</span>
                        <span class="stat-pill-val val-target">${c.targetRequests}</span>
                    </div>
                    <div class="stat-pill">
                        <span class="stat-pill-label">Luồng song song</span>
                        <span class="stat-pill-val val-workers" id="stat-workers-${c.id}">${c.maxConcurrent || (isBrowser ? 2 : 3)} luồng</span>
                    </div>
                    <div class="stat-pill">
                        <span class="stat-pill-label">Độ trễ TB</span>
                        <span class="stat-pill-val">${c.avgLatencyMs ? `${c.avgLatencyMs}ms` : '--'}</span>
                    </div>
                    <div class="stat-pill">
                        <span class="stat-pill-label">Thời gian còn</span>
                        <span class="stat-pill-val" id="meta-time-left-${c.id}">Đang tính...</span>
                    </div>
                </div>

                ${lockHintHtml}
                <div class="campaign-actions-row">
                    ${buttonsHtml}
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
                    if (d.success) {
                        showToast(`Đã khởi động chiến dịch ${id}`, 'success');
                        await loadCampaigns();
                    } else {
                        showToast(d.message || 'Lỗi khởi động chiến dịch', 'error');
                    }
                } catch (e) { showToast('Lỗi gửi lệnh bắt đầu', 'error'); }
            };
        });

        document.querySelectorAll('.btn-resume').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.id;
                try {
                    const res = await fetch(`/api/campaigns/${id}/resume`, { method: 'POST' });
                    const d = await res.json();
                    if (d.success) {
                        showToast(`Đã tiếp tục chiến dịch ${id}`, 'success');
                        await loadCampaigns();
                    } else {
                        showToast(d.message || 'Lỗi tiếp tục chiến dịch', 'error');
                    }
                } catch (e) { showToast('Lỗi gửi lệnh tiếp tục', 'error'); }
            };
        });

        document.querySelectorAll('.btn-pause').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.id;
                try {
                    const res = await fetch(`/api/campaigns/${id}/pause`, { method: 'POST' });
                    const d = await res.json();
                    if (d.success) {
                        showToast(`Đã tạm dừng chiến dịch ${id}`, 'info');
                        await loadCampaigns();
                    } else {
                        showToast(d.message || 'Lỗi tạm dừng', 'error');
                    }
                } catch (e) { showToast('Lỗi gửi lệnh tạm dừng', 'error'); }
            };
        });

        document.querySelectorAll('.btn-stop').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.id;
                if (!confirm(`Bạn có chắc muốn Dừng hẳn chiến dịch ${id}? Sau khi dừng, bạn có thể Reset hoặc Nhân bản.`)) return;
                try {
                    const res = await fetch(`/api/campaigns/${id}/stop`, { method: 'POST' });
                    const d = await res.json();
                    if (d.success) {
                        showToast(`Đã dừng chiến dịch ${id}`, 'info');
                        await loadCampaigns();
                    } else {
                        showToast(d.message || 'Lỗi dừng chiến dịch', 'error');
                    }
                } catch (e) { showToast('Lỗi gửi lệnh dừng', 'error'); }
            };
        });

        document.querySelectorAll('.btn-reset').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.id;
                if (!confirm(`Bạn có chắc muốn reset lại số liệu chiến dịch ${id}? Thao tác này sẽ đưa tiến độ về 0 và mở khóa cấu hình.`)) return;
                try {
                    const res = await fetch(`/api/campaigns/${id}/reset`, { method: 'POST' });
                    const d = await res.json();
                    if (d.success) {
                        showToast(`Đã reset tiến trình chiến dịch ${id}`, 'success');
                        await loadCampaigns();
                    } else {
                        showToast(d.message || 'Lỗi reset', 'error');
                    }
                } catch (e) { showToast('Lỗi reset', 'error'); }
            };
        });

        document.querySelectorAll('.btn-clone').forEach(btn => {
            btn.onclick = () => {
                cloneCampaignToModal(btn.dataset.id);
            };
        });

        document.querySelectorAll('.btn-chart').forEach(btn => {
            btn.onclick = () => {
                selectCampaignForChart(btn.dataset.id);
                // Switch to chart tab
                const chartTab = document.querySelector('.monitor-tab-btn[data-tab="tabChart"]');
                if (chartTab) chartTab.click();
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
                    } else {
                        showToast(d.message || 'Không thể xóa chiến dịch', 'error');
                    }
                } catch (e) { showToast('Lỗi xóa chiến dịch', 'error'); }
            };
        });

        document.querySelectorAll('.btn-view-screenshot').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (screenshotImg && screenshotModal) {
                    screenshotImg.src = btn.dataset.img;
                    screenshotModal.style.display = 'flex';
                }
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
    function setFormInputsDisabled(disabled) {
        inputTargetUrl.disabled = disabled;
        inputTargetRequests.disabled = disabled;
        inputStartTime.disabled = disabled;
        inputEndTime.disabled = disabled;
        if (inputMaxConcurrent) inputMaxConcurrent.disabled = disabled;
        if (inputTimeoutMs) inputTimeoutMs.disabled = disabled;
        document.querySelectorAll('input[name="scheduleMode"]').forEach(r => r.disabled = disabled);
        document.querySelectorAll('input[name="executionMode"]').forEach(r => r.disabled = disabled);
        if (inputProxyEnabled) inputProxyEnabled.disabled = disabled;
        if (inputProxyGateways) inputProxyGateways.disabled = disabled;
        if (inputProxyInterval) inputProxyInterval.disabled = disabled;
        document.querySelectorAll('.btn-preset').forEach(b => b.disabled = disabled);
    }

    function openCreateModal() {
        modalTitle.innerHTML = '<i class="fa-solid fa-sliders"></i> Tạo chiến dịch mới';
        editCampaignId.value = '';
        inputName.value = `QA ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
        inputTargetUrl.value = 'https://example.com';
        inputTargetRequests.value = 50;
        inputMaxConcurrent.value = 2;
        inputTimeoutMs.value = 15000;
        pingResult.innerHTML = '';

        // Default 2 hours duration
        const now = new Date();
        const end = new Date(now.getTime() + 2 * 3600000);
        inputStartTime.value = formatDateTimeLocal(now);
        inputEndTime.value = formatDateTimeLocal(end);

        // Unlock all fields
        if (modalLockedBanner) modalLockedBanner.style.display = 'none';
        setFormInputsDisabled(false);

        // Default to Browser QA
        const browserRadio = document.querySelector('input[name="executionMode"][value="browser"]');
        if (browserRadio) browserRadio.checked = true;
        const smartRadio = document.querySelector('input[name="scheduleMode"][value="smart"]');
        if (smartRadio) smartRadio.checked = true;

        // Reset proxy fields
        if (inputProxyEnabled) inputProxyEnabled.checked = false;
        if (proxyFieldsWrap) proxyFieldsWrap.style.display = 'none';
        if (inputProxyGateways) inputProxyGateways.value = '';
        if (inputProxyInterval) inputProxyInterval.value = 300;

        currentScenarioSteps = [
            { action: 'waitForSelector', selector: 'body', timeout: 5000 }
        ];
        renderScenarioSteps();
        updateProxyWarningVisibility();

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
        inputMaxConcurrent.value = c.maxConcurrent || 2;
        inputTimeoutMs.value = c.timeoutMs || 15000;
        pingResult.innerHTML = '';

        inputStartTime.value = formatDateTimeLocal(new Date(c.startTime));
        inputEndTime.value = formatDateTimeLocal(new Date(c.endTime));

        const modeRadio = document.querySelector(`input[name="scheduleMode"][value="${c.scheduleMode}"]`);
        if (modeRadio) modeRadio.checked = true;

        const execRadio = document.querySelector(`input[name="executionMode"][value="${c.executionMode || 'http'}"]`);
        if (execRadio) execRadio.checked = true;

        // Proxy config
        if (inputProxyEnabled) {
            inputProxyEnabled.checked = Boolean(c.proxyConfig?.enabled);
            if (proxyFieldsWrap) proxyFieldsWrap.style.display = c.proxyConfig?.enabled ? 'block' : 'none';
        }
        if (inputProxyGateways) {
            inputProxyGateways.value = Array.isArray(c.proxyConfig?.gateways) ? c.proxyConfig.gateways.join('\n') : '';
        }
        if (inputProxyInterval) {
            inputProxyInterval.value = c.proxyConfig?.rotationIntervalSec || 300;
        }

        if (Array.isArray(c.scenario) && c.scenario.length > 0) {
            currentScenarioSteps = JSON.parse(JSON.stringify(c.scenario.filter(s => s.action !== 'goto')));
            if (currentScenarioSteps.length === 0) {
                currentScenarioSteps = [{ action: 'waitForSelector', selector: 'body', timeout: 5000 }];
            }
        } else {
            currentScenarioSteps = [{ action: 'waitForSelector', selector: 'body', timeout: 5000 }];
        }
        renderScenarioSteps();
        updateProxyWarningVisibility();

        // Configuration locking check
        if (c.hasStarted) {
            if (modalLockedBanner) modalLockedBanner.style.display = 'block';
            setFormInputsDisabled(true);
        } else {
            if (modalLockedBanner) modalLockedBanner.style.display = 'none';
            setFormInputsDisabled(false);
        }

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

            const mode = document.querySelector('input[name="executionMode"]:checked')?.value || 'http';
            const firstProxy = (inputProxyEnabled && inputProxyEnabled.checked && inputProxyGateways)
                ? inputProxyGateways.value.split('\n').map(s => s.trim()).filter(Boolean)[0] || null
                : null;

            btnTestUrl.disabled = true;
            btnTestUrl.innerHTML = mode === 'browser'
                ? '<i class="fa-solid fa-spinner fa-spin"></i> Chromium QA...'
                : '<i class="fa-solid fa-spinner fa-spin"></i> Test Ping...';
            pingResult.className = 'ping-result';
            pingResult.textContent = mode === 'browser'
                ? 'Đang khởi chạy Chromium trên Browserless.io...'
                : 'Đang gửi HTTP subrequest qua Cloudflare Worker...';

            try {
                const res = await fetch('/api/test-url', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url,
                        mode,
                        timeoutMs: mode === 'browser' ? 15000 : 6000,
                        proxyUrl: firstProxy
                    })
                });
                const d = await res.json();

                if (d.success) {
                    pingResult.className = 'ping-result success';
                    const modeLabel = mode === 'browser' ? '🌐 Browser QA' : '⚡ HTTP';
                    const titleText = d.pageTitle ? ` • "${d.pageTitle}"` : '';
                    pingResult.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${modeLabel} OK (HTTP ${d.statusCode}, ${d.latencyMs}ms)${titleText}`;
                } else {
                    pingResult.className = 'ping-result error';
                    pingResult.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Lỗi kết nối: ${d.error || `HTTP ${d.statusCode}`} (${d.latencyMs}ms)`;
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

            const execMode = document.querySelector('input[name="executionMode"]:checked')?.value || 'browser';
            let scenario = null;
            if (execMode === 'browser') {
                scenario = [
                    { action: 'goto', url: inputTargetUrl.value.trim(), timeout: parseInt(inputTimeoutMs.value, 10) || 15000 },
                    ...currentScenarioSteps
                ];
            }

            const payload = {
                name: inputName.value.trim(),
                targetUrl: inputTargetUrl.value.trim(),
                targetRequests: parseInt(inputTargetRequests.value, 10),
                scheduleMode: document.querySelector('input[name="scheduleMode"]:checked')?.value || 'smart',
                executionMode: execMode,
                scenario,
                proxyConfig: {
                    enabled: Boolean(inputProxyEnabled && inputProxyEnabled.checked),
                    gateways: inputProxyGateways ? inputProxyGateways.value.split('\n').map(s => s.trim()).filter(Boolean) : [],
                    rotationIntervalSec: parseInt(inputProxyInterval?.value, 10) || 300
                },
                startTime: startMs,
                endTime: endMs,
                maxConcurrent: parseInt(inputMaxConcurrent.value, 10) || 2,
                timeoutMs: parseInt(inputTimeoutMs.value, 10) || 15000,
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
                if (data.storage === 'durable_objects') {
                    healthStorageVal.textContent = '🟢 Durable Objects (Strong Consistency)';
                    healthStorageDot.className = 'pulse-indicator online';
                } else if (data.storage === 'connected') {
                    healthStorageVal.textContent = '🟡 KV Connected';
                    healthStorageDot.className = 'pulse-indicator online';
                } else {
                    healthStorageVal.textContent = '⚪ Memory fallback';
                    healthStorageDot.className = 'pulse-indicator waiting';
                }
            }

            // Scheduler status
            if (healthSchedulerVal && healthSchedulerDot) {
                const engineName = data.engineType === 'durable_objects' ? 'DO Alarms (Organic Pacing)' : 'Cron';
                if (data.runningCampaigns > 0) {
                    healthSchedulerVal.textContent = `🟢 ${engineName} (${data.runningCampaigns} đang chạy)`;
                    healthSchedulerDot.className = 'pulse-indicator online';
                } else {
                    healthSchedulerVal.textContent = `⚪ ${engineName} (0 đang chạy)`;
                    healthSchedulerDot.className = 'pulse-indicator idle';
                }
            }

            // Cloudflare Access Zero Trust status
            const healthAccessVal = document.getElementById('healthAccessVal');
            const healthAccessDot = document.getElementById('healthAccessDot');
            if (healthAccessVal && healthAccessDot) {
                if (data.accessControl && data.accessControl.authenticated) {
                    healthAccessVal.textContent = data.accessControl.label;
                    healthAccessDot.className = 'pulse-indicator online';
                } else {
                    healthAccessVal.textContent = '⚪ Public (No CF Access)';
                    healthAccessDot.className = 'pulse-indicator idle';
                }
            }

            // Browserless QA status & capabilities
            const healthBrowserlessVal = document.getElementById('healthBrowserlessVal');
            const healthBrowserlessDot = document.getElementById('healthBrowserlessDot');
            if (healthBrowserlessVal && healthBrowserlessDot) {
                if (data.browserless && (data.browserless.status === 'ready' || data.browserless.status === 'connected')) {
                    healthBrowserlessVal.textContent = data.browserless.tokenConfigured
                        ? '🟢 Ready (Stateless Chromium)'
                        : '🟡 Thiếu Secret Token';
                    healthBrowserlessDot.className = data.browserless.tokenConfigured ? 'pulse-indicator online' : 'pulse-indicator waiting';
                } else {
                    healthBrowserlessVal.textContent = '⚪ Offline';
                    healthBrowserlessDot.className = 'pulse-indicator offline';
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
