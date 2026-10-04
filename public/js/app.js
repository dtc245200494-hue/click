// ─── Socket connection ─────────────────────────────────────────────────────────
const socket = io();

// ─── App State ─────────────────────────────────────────────────────────────────
let activeCampaignId = null;
const campaignStates = new Map();  // id -> { status, config, stats, logs }

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const tabsArea          = document.getElementById('campaigns-tabs-area');
const addCampaignBtn    = document.getElementById('add-campaign-btn');
const modal             = document.getElementById('add-campaign-modal');
const modalCloseBtn     = document.getElementById('modal-close-btn');
const modalCancelBtn    = document.getElementById('modal-cancel-btn');
const addCampaignForm   = document.getElementById('add-campaign-form');
const modalError        = document.getElementById('modal-error');
const modalSubmitBtn    = document.getElementById('modal-submit-btn');

const emptyCampaignsState    = document.getElementById('empty-campaigns-state');
const campaignPanelsContainer = document.getElementById('campaign-panels-container');
const activeCampaignName     = document.getElementById('active-campaign-name');
const campaignStatusPill     = document.getElementById('campaign-status-pill');
const consoleLogs            = document.getElementById('console-logs');
const clearLogBtn            = document.getElementById('clear-log-btn');
const exportLogBtn           = document.getElementById('export-log-btn');
const stopBtn                = document.getElementById('stop-btn');
const resetStatsBtn          = document.getElementById('reset-stats-btn');
const exportStatsBtn         = document.getElementById('export-stats-btn');

const statTotalClicks   = document.getElementById('stat-total-clicks');
const statSuccessClicks = document.getElementById('stat-success-clicks');
const statFailedClicks  = document.getElementById('stat-failed-clicks');
const statIps           = document.getElementById('stat-ips');
const campaignProgressBar = document.getElementById('campaign-progress-bar');
const progressBarFill   = document.querySelector('.progress-bar-fill');
const progressPercent   = document.getElementById('progress-percent');
const statEtaTime       = document.getElementById('stat-eta-time');
const statTimeRemaining = document.getElementById('stat-time-remaining');

const infoUrl          = document.getElementById('info-url');
const infoStart        = document.getElementById('info-start');
const infoEnd          = document.getElementById('info-end');
const infoTarget       = document.getElementById('info-target');
const infoBrowser      = document.getElementById('info-browser');
const infoScheduleMode = document.getElementById('info-schedule-mode');

const proxyRegionSelect   = document.getElementById('proxy-region');
const proxyKeysTextarea   = document.getElementById('proxy-keys-textarea');
const proxyConfigForm     = document.getElementById('proxy-config-form');
const proxySaveMsg        = document.getElementById('proxy-save-msg');
const proxyKeyCountBadge  = document.getElementById('proxy-key-count-badge');
const poolKeyCountHeader  = document.getElementById('pool-key-count');

const newCampaignStart    = document.getElementById('new-campaign-start');
const newCampaignEnd      = document.getElementById('new-campaign-end');
const newCampaignClicks   = document.getElementById('new-campaign-clicks');

// Schedule Mode elements
const cardModeSmart = document.getElementById('card-mode-smart');
const cardModeEven  = document.getElementById('card-mode-even');
const cardModeCustom = document.getElementById('card-mode-custom');
const customBlocksPanel = document.getElementById('custom-blocks-panel');
const hourlyPreviewBox = document.getElementById('hourly-preview-box');
const previewTotalTime = document.getElementById('preview-total-time');
const hourlyPreviewGrid = document.getElementById('hourly-preview-grid');

let currentScheduleMode = 'smart';

// ─── Datetime init ─────────────────────────────────────────────────────────────
function formatLocalDateTime(date) {
    const tzoffset = date.getTimezoneOffset() * 60000;
    return (new Date(date.getTime() - tzoffset)).toISOString().slice(0, 16);
}

function initModalDatetimes() {
    const now = new Date();
    const end = new Date(now.getTime() + 4 * 3600000);
    newCampaignStart.value = formatLocalDateTime(now);
    newCampaignEnd.value = formatLocalDateTime(end);
}
initModalDatetimes();

// ─── Schedule Mode Switcher ───────────────────────────────────────────────────
function setScheduleMode(mode) {
    currentScheduleMode = mode;
    [cardModeSmart, cardModeEven, cardModeCustom].forEach(card => {
        if (card) {
            card.style.background = 'rgba(255,255,255,0.03)';
            card.style.borderColor = 'rgba(255,255,255,0.08)';
            const title = card.querySelector('div:first-of-type');
            if (title) title.style.color = '#e2e8f0';
        }
    });

    const activeCard = mode === 'smart' ? cardModeSmart : (mode === 'even' ? cardModeEven : cardModeCustom);
    if (activeCard) {
        activeCard.style.background = 'rgba(99,102,241,0.15)';
        activeCard.style.borderColor = 'rgba(99,102,241,0.5)';
        const title = activeCard.querySelector('div:first-of-type');
        if (title) title.style.color = '#818cf8';
        const radio = activeCard.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
    }

    if (customBlocksPanel) {
        customBlocksPanel.style.display = mode === 'custom' ? 'block' : 'none';
    }

    updateHourlyPreview();
}

if (cardModeSmart) cardModeSmart.addEventListener('click', () => setScheduleMode('smart'));
if (cardModeEven) cardModeEven.addEventListener('click', () => setScheduleMode('even'));
if (cardModeCustom) cardModeCustom.addEventListener('click', () => setScheduleMode('custom'));

// ─── Hourly Distribution Preview Calculator ───────────────────────────────────
function getCustomBlocksFromUI() {
    return {
        night: document.getElementById('custom-block-night')?.value || 'low',
        early_morning: document.getElementById('custom-block-early')?.value || 'medium',
        morning: document.getElementById('custom-block-morn')?.value || 'high',
        noon: document.getElementById('custom-block-noon')?.value || 'medium',
        afternoon: document.getElementById('custom-block-after')?.value || 'high',
        evening: document.getElementById('custom-block-eve')?.value || 'high',
        late_night: document.getElementById('custom-block-late')?.value || 'medium'
    };
}

function updateHourlyPreview() {
    const clicks = parseInt(newCampaignClicks.value) || 0;
    const startVal = newCampaignStart.value;
    const endVal = newCampaignEnd.value;
    if (!clicks || !startVal || !endVal || !hourlyPreviewBox) {
        if (hourlyPreviewBox) hourlyPreviewBox.style.display = 'none';
        return;
    }

    const distBuilder = (window.TimeDistribution && window.TimeDistribution.buildTimeDistribution)
        ? window.TimeDistribution.buildTimeDistribution
        : (typeof buildTimeDistribution !== 'undefined' ? buildTimeDistribution : null);

    if (!distBuilder) return;

    const customBlocks = currentScheduleMode === 'custom' ? getCustomBlocksFromUI() : null;
    const dist = distBuilder({
        startTime: startVal,
        endTime: endVal,
        targetClicks: clicks,
        mode: currentScheduleMode,
        customBlocks,
        timezoneOffsetMinutes: new Date().getTimezoneOffset()
    });

    if (!dist.valid || dist.summaryBlocks.length === 0) {
        hourlyPreviewBox.style.display = 'none';
        return;
    }

    previewTotalTime.textContent = `Thi gian: ${dist.durationFormatted}`;

    const speedSummaryEl = document.getElementById('preview-speed-summary');
    if (speedSummaryEl) {
        const modeLabel = currentScheduleMode === 'smart' ? 'Thong minh' : (currentScheduleMode === 'even' ? 'Dong deu' : 'Tuy chinh');
        speedSummaryEl.innerHTML = `Muc tieu <strong>${clicks} luot</strong> / <strong>${dist.durationFormatted}</strong> (TB <strong>~${dist.avgIntervalSec}s/luot</strong>) &bull; <em>${modeLabel}</em>`;
    }

    // --- Feasibility Check ---
    const proxyKeysRaw = document.getElementById('proxy-keys-textarea')?.value || '';
    const keyCount = Math.max(1, proxyKeysRaw.split(/[\n,]/).map(k => k.trim()).filter(k => k.length > 5).length);
    const campaignCdRaw = document.getElementById('new-cooldown')?.value;
    const cooldownSec = (campaignCdRaw !== '' && campaignCdRaw !== undefined && !isNaN(parseInt(campaignCdRaw)))
        ? Math.max(0, parseInt(campaignCdRaw))
        : parseInt(document.getElementById('proxy-cooldown')?.value ?? '30', 10);
    const browserModeVal = document.getElementById('new-browser-mode')?.value || 'request';
    const avgWorkerSec = browserModeVal === 'request' ? 0.5 : 4;
    const secPerClickPerKey = cooldownSec + avgWorkerSec;
    const durationSec = dist.durationMs / 1000;
    const maxAchievable = Math.floor((keyCount / secPerClickPerKey) * durationSec);
    const minRequiredCooldown = Math.max(0, Math.ceil((keyCount * durationSec / clicks) - avgWorkerSec));

    let feasibilityEl = document.getElementById('preview-feasibility-warn');
    if (!feasibilityEl) {
        feasibilityEl = document.createElement('div');
        feasibilityEl.id = 'preview-feasibility-warn';
        feasibilityEl.style.cssText = 'margin-top: 10px; border-radius: 8px; padding: 10px 14px; font-size: 12px; line-height: 1.6;';
        hourlyPreviewBox.insertBefore(feasibilityEl, hourlyPreviewBox.querySelector('#hourly-preview-grid') || null);
    }

    if (maxAchievable < clicks) {
        const deficit = clicks - maxAchievable;
        const safeCd = Math.max(0, minRequiredCooldown - 1);
        feasibilityEl.style.background = 'rgba(239,68,68,0.1)';
        feasibilityEl.style.border = '1px solid rgba(239,68,68,0.3)';
        feasibilityEl.style.color = '#fca5a5';
        feasibilityEl.innerHTML = `
            <div><strong>Khong du toc do!</strong> Voi ${keyCount} key + cooldown ${cooldownSec}s, toi da ~${maxAchievable} luot trong ${dist.durationFormatted} (thieu ~${deficit}).</div>
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 8px; background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 6px;">
                <span style="color: #f87171;">💡 Can Cooldown &le; <strong>${safeCd}s</strong></span>
                <button type="button" onclick="applySuggestedCooldown(${safeCd})" style="background: linear-gradient(135deg, #ef4444, #dc2626); border: none; border-radius: 6px; padding: 5px 12px; font-size: 11.5px; font-weight: 700; color: #fff; cursor: pointer; font-family: 'Outfit', sans-serif;">
                    ⚡ Tu dong ap dung Cooldown = ${safeCd}s
                </button>
            </div>
        `;
    } else {
        const endDate = new Date(dist.endMs);
        const endFormatted = endDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ngay ' + endDate.toLocaleDateString('vi-VN');
        feasibilityEl.style.background = 'rgba(16,185,129,0.08)';
        feasibilityEl.style.border = '1px solid rgba(16,185,129,0.2)';
        feasibilityEl.style.color = '#6ee7b7';
        feasibilityEl.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                <div>
                    <div style="font-weight: 700; color: #10b981; font-size: 13px;">✅ Cong suat ly thuyet du cho muc tieu</div>
                    <div style="font-size: 12px; color: #94a3b8; margin-top: 3px;">
                        Lich duoc phan bo den: <strong style="color: #34d399;">${endFormatted}</strong>. Ket qua thuc te con phu thuoc loi mang/worker va se khong chay bu sau gio ket thuc.
                    </div>
                </div>
                <div style="font-size: 11px; background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.2); padding: 4px 10px; border-radius: 6px; color: #6ee7b7;">
                    ${keyCount} key &bull; Cooldown: ${cooldownSec}s
                </div>
            </div>
        `;
    }

    hourlyPreviewGrid.innerHTML = '';
    for (const b of dist.summaryBlocks) {
        const chip = document.createElement('div');
        chip.style.cssText = 'background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; padding: 8px 10px; font-size: 11.5px;';
        chip.innerHTML = `
            <div style="color: #94a3b8; font-weight: 600; margin-bottom: 3px; font-size: 11px;">${b.label}</div>
            <div style="display: flex; align-items: baseline; justify-content: space-between;">
                <span style="font-size: 14px; font-weight: 700; color: ${b.color};">${b.quota} luot</span>
                <span style="color: #64748b; font-size: 11px;">${b.percent}%</span>
            </div>
        `;
        hourlyPreviewGrid.appendChild(chip);
    }

    // Kich ban chi tiet theo phut
    let schedEl = document.getElementById('preview-schedule-timeline');
    if (!schedEl) {
        schedEl = document.createElement('div');
        schedEl.id = 'preview-schedule-timeline';
        schedEl.style.cssText = 'margin-top: 12px;';
        hourlyPreviewBox.appendChild(schedEl);
    }
    const schedBuilder = window.TimeDistribution && window.TimeDistribution.generateClickSchedule;
    if (schedBuilder && clicks <= 500) {
        const customB = currentScheduleMode === 'custom' ? getCustomBlocksFromUI() : null;
        const timestamps = schedBuilder(dist.startMs, dist.endMs, clicks, currentScheduleMode, customB);
        const minuteBuckets = new Map();
        for (const ts of timestamps) {
            const d = new Date(ts);
            const key = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
            minuteBuckets.set(key, (minuteBuckets.get(key) || 0) + 1);
        }
        const sortedBuckets = [...minuteBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        const maxCount = Math.max(...minuteBuckets.values());
        const MAX_SHOW = 20;
        const makeRow = ([time, count]) => {
            const barPct = Math.round((count / maxCount) * 100);
            return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">'
                + '<span style="font-family:monospace;font-size:12px;color:#818cf8;min-width:42px;">' + time + '</span>'
                + '<div style="flex:1;background:rgba(99,102,241,0.08);border-radius:4px;height:6px;overflow:hidden;">'
                + '<div style="width:' + barPct + '%;height:100%;background:linear-gradient(90deg,#6366f1,#818cf8);border-radius:4px;"></div></div>'
                + '<span style="font-size:11px;color:#94a3b8;min-width:54px;text-align:right;">' + count + ' click</span></div>';
        };
        const showing = sortedBuckets.slice(0, MAX_SHOW);
        const hidden  = sortedBuckets.slice(MAX_SHOW);
        let html = showing.map(makeRow).join('');
        if (hidden.length > 0) {
            html += '<div id="pst-hidden" style="display:none;">' + hidden.map(makeRow).join('') + '</div>';
            html += '<button onclick="var h=document.getElementById(\'pst-hidden\');var b=document.getElementById(\'pst-toggle\');if(h.style.display===\'none\'){h.style.display=\'block\';b.textContent=\'Thu gon\'}else{h.style.display=\'none\';b.textContent=\'... xem them ' + hidden.length + ' phut\';}" id="pst-toggle" style="margin-top:6px;font-size:11px;color:#6366f1;background:none;border:none;cursor:pointer;padding:0;">... xem them ' + hidden.length + ' phut</button>';
        }
        schedEl.innerHTML = '<div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Lich click du kien (theo phut)</div>'
            + '<div style="max-height:200px;overflow-y:auto;padding-right:2px;">' + html + '</div>';
    } else if (clicks > 500) {
        schedEl.innerHTML = '<div style="font-size:11px;color:#64748b;margin-top:6px;">Qua nhieu click (>500) de hien lich tung phut.</div>';
    } else {
        schedEl.innerHTML = '';
    }

    hourlyPreviewBox.style.display = 'block';
}

[newCampaignClicks, newCampaignStart, newCampaignEnd, document.getElementById('new-browser-mode'), document.getElementById('new-cooldown')].forEach(el => {
    if (el) {
        el.addEventListener('input', updateHourlyPreview);
        el.addEventListener('change', updateHourlyPreview);
    }
});

// Bind custom block select dropdowns
['custom-block-night', 'custom-block-early', 'custom-block-morn', 'custom-block-noon', 'custom-block-after', 'custom-block-eve', 'custom-block-late'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updateHourlyPreview);
});

// ─── Modal open/close ──────────────────────────────────────────────────────────
function openModal() {
    initModalDatetimes();
    addCampaignForm.reset();
    initModalDatetimes(); // re-set after reset
    setScheduleMode('smart');
    modalError.style.display = 'none';
    modal.classList.add('open');
    updateHourlyPreview();
    document.getElementById('new-campaign-url').focus();
}
function closeModal() {
    modal.classList.remove('open');
}
addCampaignBtn.addEventListener('click', openModal);
modalCloseBtn.addEventListener('click', closeModal);
modalCancelBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

// ─── Add Campaign Form submit ──────────────────────────────────────────────────
addCampaignForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    modalError.style.display = 'none';

    const startVal = newCampaignStart.value;
    const endVal   = newCampaignEnd.value;
    const startTs  = new Date(startVal).getTime();
    const endTs    = new Date(endVal).getTime();

    if (!startVal || !endVal || isNaN(startTs) || isNaN(endTs)) {
        showModalError('Vui long chon thoi gian bat dau va ket thuc hop le.');
        return;
    }
    if (endTs <= startTs) {
        showModalError('Thoi gian ket thuc phai sau thoi gian bat dau.');
        return;
    }

    let customBlocks = null;
    if (currentScheduleMode === 'custom') {
        customBlocks = {
            night: document.getElementById('custom-block-night')?.value || 'low',
            early_morning: document.getElementById('custom-block-early')?.value || 'medium',
            morning: document.getElementById('custom-block-morn')?.value || 'high',
            noon: document.getElementById('custom-block-noon')?.value || 'medium',
            afternoon: document.getElementById('custom-block-after')?.value || 'high',
            evening: document.getElementById('custom-block-eve')?.value || 'high',
            late_night: document.getElementById('custom-block-late')?.value || 'medium'
        };
    }

    const config = {
        name: document.getElementById('new-campaign-name').value.trim() || null,
        targetUrl: document.getElementById('new-campaign-url').value.trim(),
        targetClicks: parseInt(newCampaignClicks.value),
        startTime: startTs,
        endTime: endTs,
        startTimeStr: startVal,
        endTimeStr: endVal,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        scheduleMode: currentScheduleMode,
        customBlocks: customBlocks,
        cleanMode: document.getElementById('new-clean-mode').value,
        browserMode: document.getElementById('new-browser-mode').value,
        cooldownSec: (() => { const cd = document.getElementById('new-cooldown')?.value; return (cd !== '' && cd !== undefined && !isNaN(parseInt(cd))) ? Math.max(0, parseInt(cd)) : null; })(),
        dwellMin: parseInt(document.getElementById('new-dwell-min').value) || 2,
        dwellMax: parseInt(document.getElementById('new-dwell-max').value) || 5,
        humanActions: document.getElementById('new-human-actions').checked,
        randomLinks: document.getElementById('new-random-links').checked,
        dedupIp: document.getElementById('new-dedup-ip').checked
    };

    if (!config.targetUrl) { showModalError('URL muc tieu khong duoc de trong.'); return; }
    if (!config.targetClicks || config.targetClicks < 1) { showModalError('So luot click phai >= 1.'); return; }
    if (config.dwellMax < config.dwellMin) { showModalError('Thoi gian xem toi da phai >= toi thieu.'); return; }

    modalSubmitBtn.disabled = true;
    modalSubmitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Dang tao...';

    try {
        const res = await fetch('/api/campaigns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const data = await res.json();
        if (res.ok && data.success) {
            closeModal();
        } else {
            showModalError(data.message || 'Loi tao chien dich.');
        }
    } catch (err) {
        showModalError('Khong the ket noi may chu.');
    } finally {
        modalSubmitBtn.disabled = false;
        modalSubmitBtn.innerHTML = '<i class="fa-solid fa-rocket"></i> Tao chien dich';
    }
});

function showModalError(msg) {
    modalError.textContent = msg;
    modalError.style.display = 'block';
}

// ─── Proxy Config form ─────────────────────────────────────────────────────────
proxyConfigForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const region = proxyRegionSelect.value;
    const keys = proxyKeysTextarea.value
        .split(/[\n,]/)
        .map(k => k.trim())
        .filter(k => k.length > 5);
    const cooldownSec = parseInt(document.getElementById('proxy-cooldown')?.value ?? '30', 10);

    const btn = document.getElementById('save-proxy-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Dang luu...';

    try {
        const res = await fetch('/api/proxy-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ region, keys, cooldownSec })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            updateProxyPoolDisplay(keys.length);
            proxySaveMsg.style.display = 'flex';
            setTimeout(() => { proxySaveMsg.style.display = 'none'; }, 3000);
        } else {
            alert('Loi luu proxy: ' + (data.message || 'Unknown'));
        }
    } catch (err) {
        alert('Khong the ket noi may chu.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Luu cau hinh Proxy';
    }
});

function updateProxyPoolDisplay(count) {
    proxyKeyCountBadge.textContent = count;
    if (poolKeyCountHeader) poolKeyCountHeader.textContent = count;
}

// ─── Campaign tabs rendering ───────────────────────────────────────────────────
function renderCampaignTabs(campaignList) {
    // Remove existing tab buttons (keep add button)
    const existingTabs = tabsArea.querySelectorAll('.tab-btn');
    existingTabs.forEach(t => t.remove());

    if (campaignList.length === 0) {
        emptyCampaignsState.style.display = 'block';
        campaignPanelsContainer.style.display = 'none';
        return;
    }

    emptyCampaignsState.style.display = 'none';
    campaignPanelsContainer.style.display = 'block';

    // Insert tabs before the add button
    for (const c of campaignList) {
        const tab = createTabButton(c);
        tabsArea.insertBefore(tab, addCampaignBtn);
    }

    // If active campaign no longer exists, switch to first
    if (activeCampaignId === null || !campaignStates.has(activeCampaignId)) {
        switchCampaign(campaignList[0].id);
    } else {
        // Re-apply active style
        const activeTab = tabsArea.querySelector(`.tab-btn[data-campaign-id="${activeCampaignId}"]`);
        if (activeTab) activeTab.classList.add('active');
    }
}

let currentUserRole = 'admin';

function applyRoleUI(role, username) {
    currentUserRole = role;
    const isGuest = role === 'guest';

    document.body.classList.toggle('guest-mode', isGuest);

    // Hide/show Add campaign button
    if (addCampaignBtn) addCampaignBtn.style.display = isGuest ? 'none' : 'inline-flex';

    // Hide/show Global Proxy Config card
    const proxySection = document.querySelector('.proxy-pool-section');
    if (proxySection) proxySection.style.display = isGuest ? 'none' : 'block';

    // Hide/show Pool status header
    const poolHeader = document.getElementById('pool-status-header');
    if (poolHeader) poolHeader.style.display = isGuest ? 'none' : 'block';

    // Hide/show Stop and Reset buttons
    if (stopBtn) stopBtn.style.display = isGuest ? 'none' : 'inline-flex';
    const resetBtn = document.getElementById('reset-stats-btn');
    if (resetBtn) resetBtn.style.display = isGuest ? 'none' : 'inline-flex';

    // Make export stats button prominent for guest
    if (exportStatsBtn) {
        exportStatsBtn.style.cssText = isGuest
            ? 'color: #38bdf8; background: rgba(56,189,248,0.12); border: 1px solid rgba(56,189,248,0.35); border-radius: 8px; padding: 6px 14px; font-size: 13px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px; font-family: "Outfit", sans-serif;'
            : 'color: var(--primary); display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; background: transparent; border: none; cursor: pointer;';
        exportStatsBtn.innerHTML = '<i class="fa-solid fa-file-arrow-down"></i> Tai Bao Cao';
    }

    // Hide/show delete buttons on campaign tabs
    document.querySelectorAll('.tab-delete').forEach(btn => {
        btn.style.display = isGuest ? 'none' : 'inline-flex';
    });

    // Show badge for user role in header
    let userBadge = document.getElementById('header-user-badge');
    if (!userBadge) {
        userBadge = document.createElement('div');
        userBadge.id = 'header-user-badge';
        userBadge.style.cssText = 'font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 20px; display: flex; align-items: center; gap: 6px; font-family: "Outfit", sans-serif;';
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn && logoutBtn.parentNode) {
            logoutBtn.parentNode.insertBefore(userBadge, logoutBtn);
        }
    }
    if (userBadge) {
        if (isGuest) {
            userBadge.style.background = 'rgba(34, 211, 238, 0.12)';
            userBadge.style.border = '1px solid rgba(34, 211, 238, 0.3)';
            userBadge.style.color = '#22d3ee';
            userBadge.innerHTML = `<i class="fa-solid fa-eye"></i> Khach xem: <strong>${escapeHtml(username || '1')}</strong>`;
        } else {
            userBadge.style.background = 'rgba(99, 102, 241, 0.12)';
            userBadge.style.border = '1px solid rgba(99, 102, 241, 0.3)';
            userBadge.style.color = '#818cf8';
            userBadge.innerHTML = `<i class="fa-solid fa-user-shield"></i> Quyen: <strong>ADMIN (${escapeHtml(username || 'admin')})</strong>`;
        }
    }
}

function createTabButton(c) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab-btn';
    tab.setAttribute('data-campaign-id', c.id);
    if (c.id === activeCampaignId) tab.classList.add('active');

    const dotClass = statusToDotClass(c.status);
    const displayName = c.name || `Chien dich ${c.id}`;

    tab.innerHTML = `
        <span class="tab-status-dot ${escapeHtml(dotClass)}"></span>
        <span>${escapeHtml(displayName)}</span>
        <button type="button" class="tab-delete" data-campaign-id="${escapeHtml(c.id)}" title="Xoa chien dich" style="display: ${currentUserRole === 'guest' ? 'none' : 'inline-flex'};">
            <i class="fa-solid fa-xmark"></i>
        </button>
    `;

    tab.addEventListener('click', (e) => {
        if (e.target.closest('.tab-delete')) return;
        switchCampaign(c.id);
    });

    tab.querySelector('.tab-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteCampaign(c.id, displayName);
    });

    return tab;
}

function statusToDotClass(status) {
    const map = { running: 'active', waiting: 'waiting', completed: 'completed', expired: 'expired', stopped: '' };
    return map[status] || '';
}

function updateTabStatus(campaignId, status) {
    const tab = tabsArea.querySelector(`.tab-btn[data-campaign-id="${campaignId}"]`);
    if (!tab) return;
    const dot = tab.querySelector('.tab-status-dot');
    if (dot) dot.className = `tab-status-dot ${statusToDotClass(status)}`;
}

// ─── Update info panel ────────────────────────────────────────────────────────
function updateInfoPanel(config) {
    if (!config) return;
    infoUrl.textContent = config.targetUrl || '--';
    infoStart.textContent = config.startTimeStr ? config.startTimeStr.replace('T', ' ') : '--';
    infoEnd.textContent = config.endTimeStr ? config.endTimeStr.replace('T', ' ') : '--';
    infoTarget.textContent = config.targetClicks ? `${config.targetClicks} luot` : '--';
    const modeMap = { request: 'Request truc tiep (Sieu nhe)', headless: 'Chrome an (Headless)', headful: 'Chrome hien thi (Headful)' };
    infoBrowser.textContent = modeMap[config.browserMode] || (config.browserMode || '--');

    if (infoScheduleMode) {
        const schedMap = {
            'smart': '🧠 Thong minh theo gio (Smart)',
            'even': '⚖️ Dong deu (Even)',
            'custom': '⚙️ Tuy chinh theo khung (Custom)'
        };
        infoScheduleMode.textContent = schedMap[config.scheduleMode] || '🧠 Thong minh theo gio (Smart)';
    }
}

// ─── Switch active campaign ────────────────────────────────────────────────────
function switchCampaign(id) {
    activeCampaignId = id;

    // Update tab active state
    tabsArea.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
    const activeTab = tabsArea.querySelector(`.tab-btn[data-campaign-id="${id}"]`);
    if (activeTab) activeTab.classList.add('active');

    const state = campaignStates.get(id);
    if (!state) return;

    // Update header
    activeCampaignName.textContent = state.config.name || `Chien dich ${id}`;

    // Update info panel
    updateInfoPanel(state.config);

    // Update status pill
    renderStatusPill(state.status);

    // Update stop button
    const isActive = ['running', 'waiting'].includes(state.status);
    stopBtn.disabled = !isActive;

    // Update progress bar visibility
    const showProgress = ['running', 'waiting', 'completed', 'expired'].includes(state.status);
    campaignProgressBar.style.display = showProgress ? 'flex' : 'none';
    if (campaignProgressBar.style.display === 'none') campaignProgressBar.style.display = 'none';

    // Reload logs
    consoleLogs.innerHTML = '';
    const logs = state.logs || [];
    for (const log of logs) addLogLine(log.text, log.type, log.timestamp);
    if (logs.length === 0) addLogLine(`[Chien dich ${id}] San sang.`, 'system');

    // Render stats
    if (state.stats) renderStats(state.stats);
    else resetStatsDisplay();

    renderCompletionReportCard(state);
}

function renderStatusPill(status) {
    const map = {
        waiting:   { cls: 'waiting',   label: 'Cho bat dau' },
        running:   { cls: 'running',   label: 'Dang chay' },
        completed: { cls: 'completed', label: 'Hoan thanh' },
        expired:   { cls: 'expired',   label: 'Het gio' },
        stopped:   { cls: 'stopped',   label: 'Da dung' }
    };
    const s = map[status] || { cls: 'stopped', label: 'Da dung' };
    campaignStatusPill.className = `campaign-status-pill ${s.cls}`;
    campaignStatusPill.textContent = s.label;
}

// ─── Delete Campaign ───────────────────────────────────────────────────────────
async function deleteCampaign(id, name) {
    if (!confirm(`Ban co chac chan muon xoa "${name}" khong?\nThao tac nay khong the hoan tac.`)) return;
    try {
        const res = await fetch(`/api/campaigns/${id}`, { method: 'DELETE' });
        if (!res.ok) {
            const d = await res.json();
            alert('Loi xoa: ' + (d.message || 'Unknown'));
        }
    } catch (err) {
        alert('Khong the ket noi may chu.');
    }
}

// ─── Stop Campaign ─────────────────────────────────────────────────────────────
stopBtn.addEventListener('click', async () => {
    if (!activeCampaignId) return;
    if (!confirm('Ban co chac chan muon dung chien dich nay?')) return;
    try {
        await fetch(`/api/campaigns/${activeCampaignId}/stop`, { method: 'POST' });
    } catch (err) {
        socket.emit('stop-campaign', { campaignId: activeCampaignId });
    }
});

// ─── Reset Stats ───────────────────────────────────────────────────────────────
resetStatsBtn.addEventListener('click', async () => {
    if (!activeCampaignId) return;
    if (!confirm(`Reset toan bo thong ke cua Chien dich ${activeCampaignId}?`)) return;
    try {
        await fetch(`/api/campaigns/${activeCampaignId}/reset-stats`, { method: 'POST' });
    } catch (err) {
        socket.emit('reset-stats', { campaignId: activeCampaignId });
    }
    resetStatsDisplay();
});

// ─── Logs ──────────────────────────────────────────────────────────────────────
function addLogLine(message, type = 'info', timestamp = new Date()) {
    if (!(timestamp instanceof Date)) timestamp = new Date(timestamp);
    const timeStr = timestamp.toLocaleTimeString('vi-VN');
    const div = document.createElement('div');
    div.className = `log-line log-${type}`;
    div.innerHTML = `<span class="log-time">[${escapeHtml(timeStr)}]</span> ${escapeHtml(message)}`;
    consoleLogs.appendChild(div);
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
    // Limit to 500 lines
    while (consoleLogs.children.length > 500) consoleLogs.removeChild(consoleLogs.firstChild);
}

clearLogBtn.addEventListener('click', () => { consoleLogs.innerHTML = ''; });

function renderCompletionReportCard(state) {
    const reportCard = document.getElementById('completion-report-card');
    if (!reportCard) return;

    if (!state || !['completed', 'expired'].includes(state.status)) {
        reportCard.style.display = 'none';
        return;
    }

    reportCard.style.display = 'block';
    const config = state.config || {};
    const stats = state.stats || {};

    const actualStartMs = stats.actualStartTime || config.startTime;
    const actualEndMs = stats.actualEndTime || Date.now();

    const actualStartStr = actualStartMs ? new Date(actualStartMs).toLocaleString('vi-VN') : '--';
    const actualEndStr = actualEndMs ? new Date(actualEndMs).toLocaleString('vi-VN') : '--';

    let durationStr = '--';
    if (actualStartMs && actualEndMs && actualEndMs >= actualStartMs) {
        const diffMs = actualEndMs - actualStartMs;
        durationStr = window.TimeDistribution ? window.TimeDistribution.formatDuration(diffMs) : `${Math.round(diffMs/60000)} phút`;
    }

    const startEl = document.getElementById('report-actual-start');
    const endEl = document.getElementById('report-actual-end');
    const durEl = document.getElementById('report-total-duration');
    const sumEl = document.getElementById('report-click-summary');
    const downloadBtn = document.getElementById('download-completion-report-btn');

    if (startEl) startEl.textContent = actualStartStr;
    if (endEl) endEl.textContent = actualEndStr;
    if (durEl) durEl.textContent = durationStr;
    if (sumEl) sumEl.textContent = `${stats.success || 0} / ${config.targetClicks || 0} luot (Thanh cong: ${stats.success || 0}, That bai: ${stats.failed || 0})`;

    if (downloadBtn) {
        downloadBtn.onclick = () => downloadReportForCampaign(activeCampaignId);
    }
}

// ─── Stats rendering ───────────────────────────────────────────────────────────
function renderStats(data) {
    statTotalClicks.textContent   = `${data.success} / ${data.target || '--'}`;
    statSuccessClicks.textContent = data.success;
    statFailedClicks.textContent  = data.failed;
    statIps.textContent           = `${data.uniqueIps} / ${data.dupIps}`;

    if (data.target > 0) {
        const pct = Math.min(100, Math.round((data.success / data.target) * 100));
        progressPercent.textContent  = `${pct}%`;
        progressBarFill.style.width  = `${pct}%`;
        campaignProgressBar.style.display = 'flex';
    }

    if (data.etaStr) statEtaTime.textContent = data.etaStr;
    if (data.timeRemainingStr) statTimeRemaining.textContent = data.timeRemainingStr;

    const state = campaignStates.get(activeCampaignId);
    if (state) renderCompletionReportCard(state);
}

function resetStatsDisplay() {
    statTotalClicks.textContent   = '0 / --';
    statSuccessClicks.textContent = '0';
    statFailedClicks.textContent  = '0';
    statIps.textContent           = '0 / 0';
    progressBarFill.style.width   = '0%';
    progressPercent.textContent   = '0%';
    statEtaTime.textContent       = '--:--';
    statTimeRemaining.textContent = '--';
    const reportCard = document.getElementById('completion-report-card');
    if (reportCard) reportCard.style.display = 'none';
}

// ─── Export Logs ───────────────────────────────────────────────────────────────
exportLogBtn.addEventListener('click', () => {
    const logLines = Array.from(consoleLogs.querySelectorAll('.log-line')).map(l => l.textContent).join('\n');
    if (!logLines) { alert('Log trong.'); return; }
    const blob = new Blob([logLines], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    a.download = `logs_CD${activeCampaignId}_${now.toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

// ─── Export Stats Report ───────────────────────────────────────────────────────
function downloadReportForCampaign(id) {
    const state = campaignStates.get(id);
    if (!state) return;
    const stats = state.stats || {};
    const config = state.config || {};

    const schedStartStr = (config.startTimeStr || '').replace('T', ' ');
    const schedEndStr = (config.endTimeStr || '').replace('T', ' ');

    const actualStartMs = stats.actualStartTime || config.startTime;
    const actualEndMs = stats.actualEndTime || Date.now();

    const actualStartStr = actualStartMs ? new Date(actualStartMs).toLocaleString('vi-VN') : 'N/A';
    const actualEndStr = actualEndMs ? new Date(actualEndMs).toLocaleString('vi-VN') : 'N/A';

    let durationStr = 'N/A';
    if (actualStartMs && actualEndMs && actualEndMs >= actualStartMs) {
        const diffMs = actualEndMs - actualStartMs;
        durationStr = window.TimeDistribution ? window.TimeDistribution.formatDuration(diffMs) : `${Math.round(diffMs/60000)} phút`;
    }

    const modeMap = {
        'smart': '🧠 Thong minh theo gio (Smart)',
        'even': '⚖️ Dong deu (Even)',
        'custom': '⚙️ Tuy chinh (Custom)'
    };

    let report = `==================================================\n`;
    report += `  BAO CAO KET QUA CHIEN DICH CLICK LINK\n`;
    report += `==================================================\n`;
    report += `Thoi gian xuat bao cao: ${new Date().toLocaleString('vi-VN')}\n\n`;
    report += `1. THONG TIN CHIEN DICH:\n`;
    report += `   - Ten chien dich : ${config.name || `Chien dich ${id}`}\n`;
    report += `   - URL Dich        : ${config.targetUrl || 'N/A'}\n`;
    report += `   - Che do phan bo : ${modeMap[config.scheduleMode] || config.scheduleMode || 'Smart'}\n`;
    report += `   - Chi tieu        : ${config.targetClicks || 0} luot\n\n`;
    report += `2. THOI GIAN THUC THI:\n`;
    report += `   - Hen gio Bat dau : ${schedStartStr || 'N/A'}\n`;
    report += `   - Hen gio Ket thuc: ${schedEndStr || 'N/A'}\n`;
    report += `   - Bat dau thuc te : ${actualStartStr}\n`;
    report += `   - Ket thuc thuc te: ${actualEndStr}\n`;
    report += `   - Tong thoi gian  : ${durationStr}\n\n`;
    report += `3. KET QUA TRUY CAP:\n`;
    report += `   - Trang thai      : ${state.status.toUpperCase()}\n`;
    report += `   - Thanh cong      : ${stats.success || 0} luot\n`;
    report += `   - That bai        : ${stats.failed || 0} luot\n`;
    report += `   - IP Duy nhat     : ${stats.uniqueIps || 0}\n`;
    report += `   - IP Trung lap    : ${stats.dupIps || 0}\n`;
    report += `   - Ty le hoan thanh: ${config.targetClicks ? Math.min(100, Math.round(((stats.success || 0) / config.targetClicks) * 100)) : 0}%\n`;
    report += `==================================================\n`;

    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BaoCao_ChienDich_${id}_${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

exportStatsBtn.addEventListener('click', () => {
    if (activeCampaignId) downloadReportForCampaign(activeCampaignId);
});

// ─── Socket events ─────────────────────────────────────────────────────────────

socket.on('user-info', (data) => {
    if (data && data.role) {
        applyRoleUI(data.role, data.username);
    }
});

fetch('/api/me').then(r => r.json()).then(d => {
    if (d && d.success && d.role) {
        applyRoleUI(d.role, d.username);
    }
}).catch(() => {});

socket.on('proxy-config', (data) => {
    if (!data) return;
    proxyRegionSelect.value = data.region || 'random';
    proxyKeysTextarea.value = (data.keys || []).join('\n');
    updateProxyPoolDisplay(Number.isFinite(Number(data.keyCount)) ? Number(data.keyCount) : (data.keys || []).length);
    const cooldownEl = document.getElementById('proxy-cooldown');
    if (cooldownEl && data.cooldownSec !== undefined) cooldownEl.value = data.cooldownSec;
});

socket.on('campaigns-list', (list) => {
    // Update local state map
    for (const c of list) {
        if (!campaignStates.has(c.id)) {
            campaignStates.set(c.id, { status: c.status, config: c.config || {}, stats: null, logs: [] });
        } else {
            const s = campaignStates.get(c.id);
            s.status = c.status;
            if (c.config) s.config = c.config;
        }
    }

    // Remove deleted campaigns
    const serverIds = new Set(list.map(c => c.id));
    for (const id of campaignStates.keys()) {
        if (!serverIds.has(id)) campaignStates.delete(id);
    }

    renderCampaignTabs(list);

    // Refresh active campaign info panel with latest config
    if (activeCampaignId && campaignStates.has(activeCampaignId)) {
        const state = campaignStates.get(activeCampaignId);
        if (state.config && state.config.targetUrl) {
            updateInfoPanel(state.config);
        }
    }
});

socket.on('campaign-deleted', (data) => {
    const { campaignId } = data;
    campaignStates.delete(campaignId);

    // Remove tab
    const tab = tabsArea.querySelector(`.tab-btn[data-campaign-id="${campaignId}"]`);
    if (tab) tab.remove();

    // If this was active, switch to another
    if (activeCampaignId === campaignId) {
        activeCampaignId = null;
        const remaining = Array.from(campaignStates.keys());
        if (remaining.length > 0) {
            switchCampaign(remaining[0]);
        } else {
            emptyCampaignsState.style.display = 'block';
            campaignPanelsContainer.style.display = 'none';
        }
    }
});

socket.on('status-update', (data) => {
    const { campaignId, status, isRunning } = data;

    let state = campaignStates.get(campaignId);
    if (!state) {
        state = { status, config: {}, stats: null, logs: [] };
        campaignStates.set(campaignId, state);
    }
    state.status = status;

    updateTabStatus(campaignId, status);

    if (campaignId === activeCampaignId) {
        renderStatusPill(status);
        const isActive = ['running', 'waiting'].includes(status);
        stopBtn.disabled = !isActive;
    }
});

socket.on('log', (data) => {
    const { campaignId, text, type } = data;
    let state = campaignStates.get(campaignId);
    if (!state) { state = { status: 'stopped', config: {}, stats: null, logs: [] }; campaignStates.set(campaignId, state); }
    const logItem = { text, type, timestamp: new Date() };
    state.logs.push(logItem);
    if (state.logs.length > 500) state.logs.shift();

    if (campaignId === activeCampaignId) {
        addLogLine(text, type, logItem.timestamp);
    }
});

socket.on('stats-update', (data) => {
    const { campaignId } = data;
    let state = campaignStates.get(campaignId);
    if (!state) { state = { status: 'stopped', config: {}, stats: null, logs: [] }; campaignStates.set(campaignId, state); }
    state.stats = data;
    if (campaignId === activeCampaignId) {
        renderStats(data);
    }
});

socket.on('disconnect', async (reason) => {
    if (reason === 'io server disconnect') {
        try {
            const res = await fetch('/api/auth-check');
            if (!res.ok) window.location.href = '/login.html';
        } catch (e) {}
    }
});

// ─── Logout ────────────────────────────────────────────────────────────────────
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
        if (confirm('Ban co chac chan muon dang xuat?')) {
            try {
                await fetch('/api/logout', { method: 'POST' });
                window.location.href = '/login.html';
            } catch (err) { window.location.href = '/login.html'; }
        }
    });
}

// ─── Change Password ───────────────────────────────────────────────────────────
const changePasswordForm = document.getElementById('change-password-form');
const changePassBtn = document.getElementById('change-pass-btn');
if (changePasswordForm) {
    changePasswordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newUsername = document.getElementById('new-username').value.trim();
        const currentPassword = document.getElementById('current-password').value;
        const newPassword = document.getElementById('new-password').value;
        changePassBtn.disabled = true;
        changePassBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Dang cap nhat...';
        try {
            const res = await fetch('/api/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newUsername, currentPassword, newPassword })
            });
            const data = await res.json();
            if (res.ok && data.success) { alert('Cap nhat thanh cong!'); changePasswordForm.reset(); }
            else alert('Loi: ' + (data.message || 'Khong the doi mat khau.'));
        } catch (err) { alert('Khong the ket noi may chu.'); }
        finally {
            changePassBtn.disabled = false;
            changePassBtn.innerHTML = '<i class="fa-solid fa-key"></i> Cap nhat thong tin';
        }
    });
}

// ─── Apply suggested cooldown helper ─────────────────────────────────────────
window.applySuggestedCooldown = function(sec) {
    const advDetails = document.querySelector('#modal details') || document.querySelector('details');
    if (advDetails) advDetails.open = true;
    const cooldownInput = document.getElementById('new-cooldown');
    if (cooldownInput) {
        cooldownInput.value = sec;
        cooldownInput.focus();
        updateHourlyPreview();
    }
};
