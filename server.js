const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { chromium } = require('playwright');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3005;

// ─── Setup JSON and body parsing ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Admin credentials ─────────────────────────────────────────────────────────
const ADMIN_CONFIG_PATH = path.join(__dirname, 'admin.json');

function hashPassword(password, salt) {
    const hash = crypto.createHmac('sha256', salt);
    hash.update(password);
    return hash.digest('hex');
}

function initAdminAccount() {
    if (!fs.existsSync(ADMIN_CONFIG_PATH)) {
        const salt = crypto.randomBytes(16).toString('hex');
        const defaultPassword = 'admin123456';
        const passwordHash = hashPassword(defaultPassword, salt);
        const config = { username: 'admin', salt, passwordHash };
        fs.writeFileSync(ADMIN_CONFIG_PATH, JSON.stringify(config, null, 4));
        console.log('\n==================================================');
        console.log('Tai khoan mac dinh: admin / admin123456');
        console.log('==================================================\n');
    }
}

function updateAdminAccount(newUsername, newPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(newPassword, salt);
    fs.writeFileSync(ADMIN_CONFIG_PATH, JSON.stringify({ username: newUsername, salt, passwordHash }, null, 4));
}

function verifyAdminCredentials(username, password) {
    if (!fs.existsSync(ADMIN_CONFIG_PATH)) initAdminAccount();
    try {
        const config = JSON.parse(fs.readFileSync(ADMIN_CONFIG_PATH, 'utf-8'));
        if (config.username !== username) return false;
        return hashPassword(password, config.salt) === config.passwordHash;
    } catch (e) {
        return false;
    }
}

// ─── Sessions ──────────────────────────────────────────────────────────────────
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
function loadSessions() {
    const map = new Map();
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
            for (const [k, v] of Object.entries(data)) map.set(k, v);
        }
    } catch (e) {}
    return map;
}
function saveSessions() {
    try {
        const obj = {};
        for (const [k, v] of activeSessions.entries()) obj[k] = v;
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {}
}
const activeSessions = loadSessions();

// ─── Cookie helpers ────────────────────────────────────────────────────────────
function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
    return list;
}

// ─── Campaigns Directory ───────────────────────────────────────────────────────
const CAMPAIGNS_DIR = path.join(__dirname, 'campaigns');
if (!fs.existsSync(CAMPAIGNS_DIR)) fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });

// ─── Global Proxy Config ───────────────────────────────────────────────────────
const PROXY_CONFIG_PATH = path.join(__dirname, 'proxy_config.json');

function loadProxyConfig() {
    try {
        if (fs.existsSync(PROXY_CONFIG_PATH)) {
            const d = JSON.parse(fs.readFileSync(PROXY_CONFIG_PATH, 'utf-8'));
            if (d.cooldownSec === undefined) d.cooldownSec = 30;
            return d;
        }
    } catch (e) {}
    return { region: 'random', keys: [], cooldownSec: 30 };
}

function saveProxyConfig(config) {
    fs.writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(config, null, 4));
}

let proxyConfigData = loadProxyConfig();

function proxyConfigForRole(role) {
    if (role === 'admin') return proxyConfigData;
    return {
        region: proxyConfigData.region || 'random',
        cooldownSec: proxyConfigData.cooldownSec ?? 30,
        keyCount: Array.isArray(proxyConfigData.keys) ? proxyConfigData.keys.length : 0,
        keys: []
    };
}

// ─── Telegram Bot Config & Notifications ───────────────────────────────────────
const TELEGRAM_CONFIG_PATH = path.join(__dirname, 'telegram_config.json');

function loadTelegramConfig() {
    try {
        if (fs.existsSync(TELEGRAM_CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(TELEGRAM_CONFIG_PATH, 'utf-8'));
        }
    } catch (e) {}
    return {
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatIds: [],
        notifyOnComplete: true,
        sendFileReport: true
    };
}

function saveTelegramConfig() {
    try {
        fs.writeFileSync(TELEGRAM_CONFIG_PATH, JSON.stringify(telegramConfig, null, 4));
    } catch (e) {}
}

let telegramConfig = loadTelegramConfig();
// Environment variable overrides the file value without persisting the secret back to disk.
if (process.env.TELEGRAM_BOT_TOKEN) telegramConfig.botToken = process.env.TELEGRAM_BOT_TOKEN;

async function sendTelegramMessage(chatId, htmlText) {
    if (!telegramConfig.botToken || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`, {
            chat_id: chatId,
            text: htmlText,
            parse_mode: 'HTML'
        }, { timeout: 10000 });
    } catch (e) {
        console.error(`[Telegram] Error sending message to ${chatId}:`, e.message);
    }
}

async function sendTelegramDocument(chatId, filePath, caption) {
    if (!telegramConfig.botToken || !chatId || !fs.existsSync(filePath)) return;
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);
        const boundary = '----TelegramBoundary' + Math.random().toString(36).substring(2);

        let body = [];
        body.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
            `${chatId}\r\n`
        ));
        if (caption) {
            body.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="caption"\r\n\r\n` +
                `${caption}\r\n`
            ));
            body.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="parse_mode"\r\n\r\n` +
                `HTML\r\n`
            ));
        }
        body.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="document"; filename="${fileName}"\r\n` +
            `Content-Type: text/plain\r\n\r\n`
        ));
        body.push(fileBuffer);
        body.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        const payload = Buffer.concat(body);

        await axios.post(`https://api.telegram.org/bot${telegramConfig.botToken}/sendDocument`, payload, {
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            timeout: 20000
        });
    } catch (e) {
        console.error(`[Telegram] Error sending document to ${chatId}:`, e.message);
    }
}

async function notifyTelegramCampaignComplete(campaignId) {
    const campaign = campaigns.get(campaignId);
    if (!campaign || !telegramConfig.notifyOnComplete || (telegramConfig.chatIds || []).length === 0) return;

    const actualStartMs = campaign.actualStartTime || campaign.startTime;
    const actualEndMs = campaign.actualEndTime || Date.now();
    const actualStartStr = actualStartMs ? new Date(actualStartMs).toLocaleString('vi-VN') : 'N/A';
    const actualEndStr = actualEndMs ? new Date(actualEndMs).toLocaleString('vi-VN') : 'N/A';
    let durationStr = 'N/A';
    if (actualStartMs && actualEndMs && actualEndMs >= actualStartMs) {
        const diffMs = actualEndMs - actualStartMs;
        const mins = Math.floor(diffMs / 60000);
        const secs = Math.floor((diffMs % 60000) / 1000);
        durationStr = `${mins} phut ${secs}s`;
    }

    const campaignName = campaign.config.name || `Chien dich ${campaignId}`;
    const targetUrl = campaign.config.targetUrl || 'N/A';
    const targetClicks = campaign.targetLimit || 0;
    const successVisits = campaign.successVisits || 0;
    const failedVisits = campaign.failedVisits || 0;
    const uniqueIps = campaign.usedIps ? campaign.usedIps.size : 0;
    const dupIps = campaign.dupIpsCount || 0;
    const pct = targetClicks ? Math.min(100, Math.round((successVisits / targetClicks) * 100)) : 0;

    const htmlMsg = `🎉 <b>CHIEN DICH HOAN THANH XUAT SAC!</b>\n\n`
        + `📋 <b>Chien dich:</b> ${campaignName}\n`
        + `🔗 <b>URL Muc tieu:</b> ${targetUrl}\n`
        + `🎯 <b>Chi tieu:</b> ${successVisits}/${targetClicks} luot (${pct}%)\n`
        + `✅ <b>Thanh cong:</b> ${successVisits} | ❌ <b>That bai:</b> ${failedVisits}\n`
        + `👥 <b>IP Duy nhat:</b> ${uniqueIps} | 🔄 <b>IP Trung:</b> ${dupIps}\n\n`
        + `⏱️ <b>Bat dau thuc te:</b> ${actualStartStr}\n`
        + `🏁 <b>Ket thuc thuc te:</b> ${actualEndStr}\n`
        + `⏳ <b>Tong thoi gian:</b> ${durationStr}\n\n`
        + `📁 <i>Bao cao chi tiet dang file .txt da duoc tu dong tao va gui kem ben duoi.</i>`;

    const reportText = `==================================================\n`
        + `  BAO CAO KET QUA CHIEN DICH CLICK LINK (TELEGRAM)\n`
        + `==================================================\n`
        + `Thoi gian xuat: ${new Date().toLocaleString('vi-VN')}\n\n`
        + `1. THONG TIN CHIEN DICH:\n`
        + `   - Ten chien dich : ${campaignName}\n`
        + `   - URL Dich        : ${targetUrl}\n`
        + `   - Che do phan bo : ${campaign.config.scheduleMode || 'Smart'}\n`
        + `   - Chi tieu        : ${targetClicks} luot\n\n`
        + `2. THOI GIAN THUC THI:\n`
        + `   - Bat dau thuc te : ${actualStartStr}\n`
        + `   - Ket thuc thuc te: ${actualEndStr}\n`
        + `   - Tong thoi gian  : ${durationStr}\n\n`
        + `3. KET QUA TRUY CAP:\n`
        + `   - Trang thai      : ${campaign.status.toUpperCase()}\n`
        + `   - Thanh cong      : ${successVisits} luot\n`
        + `   - That bai        : ${failedVisits} luot\n`
        + `   - IP Duy nhat     : ${uniqueIps}\n`
        + `   - IP Trung lap    : ${dupIps}\n`
        + `   - Ty le hoan thanh: ${pct}%\n`
        + `==================================================\n`;

    const reportFileName = `BaoCao_ChienDich_${campaignId}_${new Date().toISOString().slice(0,10)}.txt`;
    const tempReportPath = path.join(__dirname, reportFileName);

    try {
        fs.writeFileSync(tempReportPath, reportText, 'utf-8');
        for (const chatId of telegramConfig.chatIds) {
            if (telegramConfig.sendFileReport) {
                await sendTelegramDocument(chatId, tempReportPath, htmlMsg);
            } else {
                await sendTelegramMessage(chatId, htmlMsg);
            }
        }
    } catch (err) {
        console.error(`[Telegram] Error notifying campaign complete:`, err.message);
    } finally {
        if (fs.existsSync(tempReportPath)) {
            try { fs.unlinkSync(tempReportPath); } catch (e) {}
        }
    }
}

// Telegram auto chat_id discovery polling (Supports Private Chats, Groups & Channels)
let telegramOffset = 0;
async function pollTelegramUpdates() {
    if (!telegramConfig.botToken) return;
    try {
        const url = `https://api.telegram.org/bot${telegramConfig.botToken}/getUpdates?offset=${telegramOffset}&timeout=5`;
        const res = await axios.get(url, { timeout: 10000 });
        if (res.data && res.data.ok && Array.isArray(res.data.result)) {
            for (const update of res.data.result) {
                telegramOffset = update.update_id + 1;
                const msg = update.message || update.channel_post || update.edited_message;
                const chat = msg?.chat || update.my_chat_member?.chat;

                if (chat && chat.id) {
                    const chatId = chat.id;
                    const isNew = !telegramConfig.chatIds.includes(chatId);
                    if (isNew) {
                        telegramConfig.chatIds.push(chatId);
                        saveTelegramConfig();
                        console.log(`[Telegram] Registered new chat_id: ${chatId} (${chat.title || chat.username || 'chat'})`);
                    }

                    const text = msg?.text || '';
                    if (isNew || text.startsWith('/start') || text.startsWith('/help') || text.includes('@jun88v2_niadev_bot')) {
                        const chatTitle = chat.title ? ` (<b>${chat.title}</b>)` : '';
                        await sendTelegramMessage(chatId, `✅ <b>Da ket noi Telegram Bot thanh cong!</b>${chatTitle}\n\n`
                            + `🤖 Bot: <b>@jun88v2_niadev_bot</b>\n`
                            + `📌 Chat ID: <code>${chatId}</code>\n\n`
                            + `Nhom/Kenh se <b>tu dong nhan duoc thong bao & file bao cao chi tiet (.txt)</b> truc tiep tai day moi khi co chien dich hoan thanh!`);
                    }
                }
            }
        }
    } catch (e) {}
}
setInterval(pollTelegramUpdates, 8000);

// ─── Global Proxy Pool ─────────────────────────────────────────────────────────
const globalProxyPool = new Map();

function initProxyPool() {
    // Keep existing keyState if key still present (preserve cooldowns)
    const oldKeys = new Set(globalProxyPool.keys());
    const newKeys = new Set(proxyConfigData.keys || []);

    // Remove keys no longer in config
    for (const k of oldKeys) {
        if (!newKeys.has(k)) globalProxyPool.delete(k);
    }
    // Add new keys
    for (const key of newKeys) {
        if (!globalProxyPool.has(key)) {
            globalProxyPool.set(key, {
                key,
                currentProxy: null,
                nextRequestAt: 0,
                isBusy: false,
                campaignId: null
            });
        }
    }
}
initProxyPool();

// Acquire a free key from pool (fair: prefer keys not in use by same campaign)
function acquireKey(campaignId) {
    const now = Date.now();
    const available = [];
    for (const [, state] of globalProxyPool.entries()) {
        if (!state.isBusy && now >= state.nextRequestAt) {
            available.push(state);
        }
    }
    if (available.length === 0) return null;
    const preferOther = available.filter(s => s.campaignId !== campaignId);
    const chosen = (preferOther.length > 0 ? preferOther : available)[0];
    chosen.isBusy = true;
    chosen.campaignId = campaignId;
    return chosen;
}

function releaseKey(key) {
    const state = globalProxyPool.get(key);
    if (state) {
        state.isBusy = false;
        state.campaignId = null;
    }
}

// ─── Migration: old campaign_config_1.json / _2.json ──────────────────────────
function migrateOldConfigs() {
    for (const id of ['1', '2']) {
        const oldPath = path.join(__dirname, `campaign_config_${id}.json`);
        const newPath = path.join(CAMPAIGNS_DIR, `${id}.json`);
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
            try {
                const oldConfig = JSON.parse(fs.readFileSync(oldPath, 'utf-8'));
                const newConfig = {
                    name: `Chien dich ${id} (Migrated)`,
                    targetUrl: oldConfig.targetUrl || '',
                    targetClicks: oldConfig.targetClicks || 100,
                    startTimeStr: oldConfig.startTimeStr || null,
                    endTimeStr: oldConfig.endTimeStr || null,
                    startTime: oldConfig.startTime || (Date.now() + 60000),
                    endTime: oldConfig.endTime || (Date.now() + 4 * 3600000),
                    cleanMode: oldConfig.cleanMode || 'incognito',
                    browserMode: oldConfig.browserMode || 'request',
                    dwellMin: oldConfig.dwellMin || 2,
                    dwellMax: oldConfig.dwellMax || 5,
                    humanActions: oldConfig.humanActions !== false,
                    randomLinks: oldConfig.randomLinks !== false,
                    dedupIp: oldConfig.dedupIp || false
                };
                fs.writeFileSync(newPath, JSON.stringify(newConfig, null, 4));
                console.log(`[Migration] campaign_config_${id}.json -> campaigns/${id}.json`);

                if (oldConfig.proxyKeys && oldConfig.proxyKeys.length > 0 && proxyConfigData.keys.length === 0) {
                    proxyConfigData.keys = [...new Set([...proxyConfigData.keys, ...oldConfig.proxyKeys])];
                    if (oldConfig.region) proxyConfigData.region = oldConfig.region;
                    saveProxyConfig(proxyConfigData);
                    initProxyPool();
                    console.log(`[Migration] Proxy keys migrated to proxy_config.json`);
                }
            } catch (e) {
                console.error(`[Migration] Error campaign ${id}:`, e.message);
            }
        }
    }
}

// ─── Smart Hourly Weights & Schedule Generator ─────────────────────────────────
const { generateClickSchedule, buildTimeDistribution, formatDuration } = require('./timeDistribution');

// ─── Campaign State ────────────────────────────────────────────────────────────
const campaigns = new Map();

function inferTimezoneOffsetMinutes(config) {
    if (Number.isFinite(Number(config.timezoneOffsetMinutes))) {
        return Math.max(-840, Math.min(840, Number(config.timezoneOffsetMinutes)));
    }
    // Backward compatibility for old saved campaigns: infer the browser offset
    // from the wall-clock string and the absolute epoch sent by the browser.
    if (config.startTimeStr && Number.isFinite(Number(config.startTime))) {
        const wallClockAsUtc = Date.parse(`${config.startTimeStr}:00Z`.replace(/:00:00Z$/, ':00Z'));
        if (Number.isFinite(wallClockAsUtc)) {
            const inferred = Math.round((Number(config.startTime) - wallClockAsUtc) / 60000);
            if (inferred >= -840 && inferred <= 840) return inferred;
        }
    }
    return null;
}

function createCampaignState(id, config) {
    const scheduleMode = config.scheduleMode || 'smart';
    const customBlocks = config.customBlocks || null;
    const timezoneOffsetMinutes = inferTimezoneOffsetMinutes(config);
    const schedule = generateClickSchedule(
        config.startTime, config.endTime, config.targetClicks, scheduleMode, customBlocks, timezoneOffsetMinutes
    );
    const now = Date.now();
    let status = 'waiting';
    if (now >= config.endTime) status = 'expired';
    else if (now >= config.startTime) status = 'running';

    return {
        id,
        config: {
            ...config,
            scheduleMode,
            timezoneOffsetMinutes
        },
        status,
        startTime: config.startTime,
        endTime: config.endTime,
        actualStartTime: status === 'running' ? now : null,
        actualEndTime: null,
        targetLimit: config.targetClicks,
        schedule,
        scheduleIdx: 0,
        totalVisits: 0,
        successVisits: 0,
        failedVisits: 0,
        usedIps: new Set(),
        dupIpsCount: 0,
        activeWorkers: 0,
        lastWaitingLogTime: 0,
        retryQueue: [],
        maxRetriesPerSlot: Number.isInteger(config.maxRetriesPerSlot) ? Math.max(0, Math.min(5, config.maxRetriesPerSlot)) : 2,
        retryBackoffMs: Number.isFinite(Number(config.retryBackoffMs)) ? Math.max(250, Math.min(30000, Number(config.retryBackoffMs))) : 2000,
        _tickRunning: false
    };
}

// ─── Load campaigns from disk ──────────────────────────────────────────────────
function loadCampaignsFromDisk() {
    try {
        const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
            const id = file.replace('.json', '');
            try {
                const config = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, file), 'utf-8'));
                if (!config.targetUrl || !config.startTime || !config.endTime) continue;
                const state = createCampaignState(id, config);
                campaigns.set(id, state);
            } catch (e) {
                console.error(`[Load] Error reading campaign ${file}:`, e.message);
            }
        }
        console.log(`[Load] Loaded ${campaigns.size} campaigns from disk.`);
    } catch (e) {}
}

function saveCampaignConfig(id, config) {
    try {
        fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${id}.json`), JSON.stringify(config, null, 4));
    } catch (e) {
        console.error(`Error saving campaign ${id}:`, e.message);
    }
}

function deleteCampaignFile(id) {
    try {
        const p = path.join(CAMPAIGNS_DIR, `${id}.json`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {}
}

function generateCampaignId() {
    const existingIds = Array.from(campaigns.keys()).map(Number).filter(n => !isNaN(n));
    if (existingIds.length === 0) return '1';
    return String(Math.max(...existingIds) + 1);
}

// ─── User-Agents pool ──────────────────────────────────────────────────────────
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Edge/122.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/605.1.15',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Android 14; Mobile; rv:123.0) Gecko/123.0 Firefox/123.0'
];

const VIEWPORTS = [
    { width: 1920, height: 1080 }, { width: 1536, height: 864 },
    { width: 1440, height: 900 }, { width: 1366, height: 768 }
];
const MOBILE_VIEWPORTS = [
    { width: 390, height: 844 }, { width: 412, height: 915 },
    { width: 360, height: 800 }, { width: 430, height: 932 }
];

function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function getRandomRange(min, max) {
    min = Math.ceil(Number(min));
    max = Math.floor(Number(max));
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = min;
    if (max < min) max = min;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Log & Stats ───────────────────────────────────────────────────────────────
function sendLog(campaignId, text, type = 'info') {
    console.log(`[C${campaignId}][${type.toUpperCase()}] ${text}`);
    io.emit('log', { campaignId, text, type });
}

function emitStats(campaignId) {
    const campaign = campaigns.get(campaignId);
    if (!campaign) return;
    const now = Date.now();
    const timeLeft = campaign.endTime ? Math.max(0, campaign.endTime - now) : null;
    let etaStr = '--:--', timeRemainingStr = '';
    if (campaign.endTime) {
        etaStr = new Date(campaign.endTime).toLocaleTimeString('vi-VN');
        const minsLeft = Math.floor(timeLeft / 60000);
        const secsLeft = Math.floor((timeLeft % 60000) / 1000);
        if (campaign.status === 'waiting' && campaign.startTime > now) {
            const toStart = campaign.startTime - now;
            timeRemainingStr = `Cho chay (con ${Math.floor(toStart / 60000)}p ${Math.floor((toStart % 60000) / 1000)}s)`;
        } else {
            timeRemainingStr = `${minsLeft}p ${secsLeft}s`;
        }
    }
    io.emit('stats-update', {
        campaignId, status: campaign.status,
        total: campaign.totalVisits, target: campaign.targetLimit || 0,
        success: campaign.successVisits, failed: campaign.failedVisits,
        uniqueIps: campaign.usedIps.size, dupIps: campaign.dupIpsCount,
        etaStr, timeRemainingStr, timeRemainingMs: timeLeft,
        startTimeStr: campaign.config.startTimeStr,
        endTimeStr: campaign.config.endTimeStr,
        actualStartTime: campaign.actualStartTime,
        actualEndTime: campaign.actualEndTime
    });
}

function emitCampaignList() {
    const list = [];
    for (const [id, c] of campaigns.entries()) {
        list.push({
            id, name: c.config.name || `Chien dich ${id}`,
            targetUrl: c.config.targetUrl, status: c.status,
            successVisits: c.successVisits, targetLimit: c.targetLimit,
            startTimeStr: c.config.startTimeStr, endTimeStr: c.config.endTimeStr,
            config: c.config  // always include full config
        });
    }
    io.emit('campaigns-list', list);
}

// ─── KiotProxy API ─────────────────────────────────────────────────────────────
async function fetchNewProxy(campaignId, keyState) {
    const region = proxyConfigData.region || 'random';
    const url = `https://api.kiotproxy.com/api/v1/proxies/new?key=${keyState.key}&region=${region}`;
    try {
        sendLog(campaignId, `[Key: ...${keyState.key.slice(-5)}] Dang xoay IP moi...`, 'info');
        const response = await axios.get(url, { timeout: 10000 });
        if (response.data && response.data.success) {
            const proxyData = response.data.data;
            keyState.currentProxy = proxyData;
            keyState.nextRequestAt = Date.now() + (proxyData.ttc * 1000);
            sendLog(campaignId, `[Key: ...${keyState.key.slice(-5)}] Doi proxy thanh cong: ${proxyData.realIpAddress} (${proxyData.location}, TTL: ${proxyData.ttl}s, Cho: ${proxyData.ttc}s)`, 'success');
            return proxyData;
        } else {
            sendLog(campaignId, `[Key: ...${keyState.key.slice(-5)}] Doi proxy that bai: ${response.data ? response.data.message : 'Unknown'}`, 'warn');
            return null;
        }
    } catch (error) {
        sendLog(campaignId, `[Key: ...${keyState.key.slice(-5)}] Loi API doi proxy: ${error.message}`, 'error');
        return null;
    }
}

async function fetchCurrentProxy(campaignId, keyState) {
    const url = `https://api.kiotproxy.com/api/v1/proxies/current?key=${keyState.key}`;
    try {
        const response = await axios.get(url, { timeout: 10000 });
        if (response.data && response.data.success) {
            const proxyData = response.data.data;
            keyState.currentProxy = proxyData;
            keyState.nextRequestAt = Date.now() + (proxyData.ttc * 1000);
            return proxyData;
        }
    } catch (e) {}
    return null;
}

async function fetchOutProxy(key) {
    if (!key) return;
    try { await axios.get(`https://api.kiotproxy.com/api/v1/proxies/out?key=${key}`, { timeout: 8000 }); } catch (e) {}
}

// ─── Human simulation ──────────────────────────────────────────────────────────
async function simulateHuman(campaignId, page, randomLinks) {
    try {
        await page.waitForTimeout(getRandomRange(1000, 3000));
        const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        const viewportHeight = await page.evaluate(() => window.innerHeight);
        let currentScroll = 0;
        sendLog(campaignId, 'Bat dau cuon trang gia lap...', 'browser');
        while (currentScroll < scrollHeight - viewportHeight && currentScroll < 3000) {
            currentScroll += getRandomRange(150, 350);
            await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), currentScroll);
            await page.waitForTimeout(getRandomRange(800, 2500));
            await page.mouse.move(getRandomRange(100, 800), getRandomRange(100, 600), { steps: getRandomRange(5, 12) });
        }
        await page.evaluate(() => window.scrollTo({ top: Math.max(0, window.scrollY - 400), behavior: 'smooth' }));
        await page.waitForTimeout(getRandomRange(1000, 2000));

        if (randomLinks) {
            const currentUrl = page.url();
            const urlObj = new URL(currentUrl);
            const host = urlObj.hostname;
            const links = await page.evaluate((domain) => {
                return Array.from(document.querySelectorAll('a'))
                    .map(a => ({ href: a.href, text: a.textContent ? a.textContent.trim() : '' }))
                    .filter(a => {
                        try {
                            const linkUrl = new URL(a.href);
                            return linkUrl.hostname === domain && !a.href.includes('#') && !a.href.endsWith('.pdf') && a.href !== window.location.href;
                        } catch { return false; }
                    });
            }, host);
            if (links.length > 0) {
                const targetLink = getRandomItem(links);
                sendLog(campaignId, `Click link noi bo: "${targetLink.text}" -> ${targetLink.href}`, 'browser');
                await page.goto(targetLink.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(getRandomRange(3000, 6000));
                await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'smooth' }));
                await page.waitForTimeout(getRandomRange(2000, 4000));
            }
        }
    } catch (e) {
        sendLog(campaignId, `Loi mo phong hanh vi: ${e.message}`, 'warn');
    }
}

async function clearSettingsBrowserData(campaignId, context, keyName) {
    let settingsPage = null;
    try {
        settingsPage = await context.newPage();
        await settingsPage.goto('chrome://settings/clearBrowserData', { timeout: 30000 });
        await settingsPage.waitForTimeout(6000);
        const clicked = await settingsPage.evaluate(() => {
            function findElementDeep(root, selector) {
                if (!root) return null;
                if (root.querySelector) { const match = root.querySelector(selector); if (match) return match; }
                for (let child of (root.children || [])) {
                    const res = findElementDeep(child, selector); if (res) return res;
                    if (child.shadowRoot) { const sr = findElementDeep(child.shadowRoot, selector); if (sr) return sr; }
                }
                return null;
            }
            const btn = findElementDeep(document, '#deleteButton');
            if (btn) { btn.click(); return { success: true }; }
            return { success: false };
        });
        if (clicked.success) await settingsPage.waitForTimeout(5000);
    } catch (e) {
        sendLog(campaignId, `Loi xoa Settings: ${e.message}`, 'error');
    } finally {
        if (settingsPage) await settingsPage.close().catch(() => {});
    }
}

// ─── Worker ────────────────────────────────────────────────────────────────────
async function runVisitWorker(campaignId, keyState, job = { slotId: null, attempt: 0 }) {
    const campaign = campaigns.get(campaignId);
    if (!campaign) { releaseKey(keyState.key); return; }

    campaign.activeWorkers++;
    campaign.totalVisits++;
    emitStats(campaignId);

    const shortKey = keyState.key.slice(-5);
    const targetUrl = campaign.config.targetUrl;
    const cleanMode = campaign.config.cleanMode;
    const proxyIpPort = keyState.currentProxy ? keyState.currentProxy.http : null;
    const realIp = keyState.currentProxy ? keyState.currentProxy.realIpAddress : 'Direct';

    sendLog(campaignId, `Khoi chay worker | Key: ...${shortKey} | IP: ${realIp}`, 'info');

    let browser = null, context = null, page = null, success = false;

    try {
        const userAgent = getRandomItem(USER_AGENTS);

        if (campaign.config.browserMode === 'request') {
            let proxyConfig = false;
            if (proxyIpPort) {
                const [proxyHost, proxyPortStr] = proxyIpPort.split(':');
                proxyConfig = { host: proxyHost, port: parseInt(proxyPortStr) };
            }
            const referer = getRandomItem([
                'https://www.google.com/', 'https://www.google.com.vn/', 'https://www.google.com.vn/',
                'https://www.facebook.com/', 'https://m.facebook.com/', 'https://www.bing.com/',
                '', '', '', ''
            ]);
            const isMobileUA = userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone');
            const baseHeaders = {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': getRandomItem(['vi-VN,vi;q=0.9,en-US;q=0.8', 'vi,en-US;q=0.9,en;q=0.8']),
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'max-age=0',
                'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate',
                'sec-fetch-site': referer ? 'cross-site' : 'none',
                ...(isMobileUA ? {} : { 'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"' }),
                ...(Math.random() > 0.5 ? { 'DNT': '1' } : {})
            };
            if (referer) baseHeaders['Referer'] = referer;

            const mainResponse = await axios.get(targetUrl, {
                proxy: proxyConfig, headers: baseHeaders, timeout: 30000, maxRedirects: 5, validateStatus: () => true
            });
            if (mainResponse.status < 200 || mainResponse.status >= 400) {
                throw new Error(`HTTP ${mainResponse.status}`);
            }
            sendLog(campaignId, `[Key: ...${shortKey}] Tai trang thanh cong (HTTP ${mainResponse.status}).`, 'success');

            const firstDwell = getRandomRange(Math.max(1, Math.floor(campaign.config.dwellMin * 0.4)), Math.floor(campaign.config.dwellMax * 0.5));
            await new Promise(resolve => setTimeout(resolve, firstDwell * 1000));

            if (campaign.config.randomLinks && mainResponse.data && typeof mainResponse.data === 'string') {
                try {
                    const html = mainResponse.data;
                    const urlObj = new URL(targetUrl);
                    const baseHost = urlObj.origin;
                    const hrefMatches = [...html.matchAll(/href=["']([^"'#]+?)["']/gi)];
                    const internalLinks = hrefMatches.map(m => {
                        try {
                            const href = m[1].trim();
                            if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return null;
                            if (href.startsWith('http')) { const u = new URL(href); return u.hostname === urlObj.hostname ? href : null; }
                            else if (href.startsWith('/')) return baseHost + href;
                            return null;
                        } catch { return null; }
                    }).filter(l => l && l !== targetUrl && !/\.(pdf|jpg|jpeg|png|gif|svg|css|js|ico|woff)$/i.test(l));
                    const uniqueInternalLinks = [...new Set(internalLinks)];
                    if (uniqueInternalLinks.length > 0) {
                        const subLink = getRandomItem(uniqueInternalLinks);
                        await new Promise(resolve => setTimeout(resolve, getRandomRange(800, 2500)));
                        await axios.get(subLink, {
                            proxy: proxyConfig, headers: { ...baseHeaders, 'Referer': targetUrl, 'sec-fetch-site': 'same-origin' },
                            timeout: 20000, maxRedirects: 3, validateStatus: () => true
                        });
                        sendLog(campaignId, `[Key: ...${shortKey}] Click link noi bo: ${subLink.slice(0, 70)}`, 'browser');
                    }
                } catch (e) {}
            }

            const remainDwell = getRandomRange(Math.max(1, Math.floor(campaign.config.dwellMin * 0.4)), Math.floor(campaign.config.dwellMax * 0.5));
            await new Promise(resolve => setTimeout(resolve, remainDwell * 1000));
            success = true;
            sendLog(campaignId, `[Key: ...${shortKey}] Luot truy cap hoan tat! (~${firstDwell + remainDwell}s)`, 'success');

        } else {
            const isHeadless = campaign.config.browserMode === 'headless';
            const isMobileUA = userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone') || userAgent.includes('iPad');
            let viewport;
            let contextOptions = { userAgent };
            if (proxyIpPort) contextOptions.proxy = { server: `http://${proxyIpPort}` };
            if (isMobileUA) { viewport = getRandomItem(MOBILE_VIEWPORTS); contextOptions.viewport = viewport; contextOptions.isMobile = true; contextOptions.hasTouch = true; }
            else { viewport = getRandomItem(VIEWPORTS); if (isHeadless) contextOptions.viewport = viewport; }

            const headlessArgs = ['--disable-gpu', '--no-startup-window', '--hide-scrollbars', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--mute-audio', '--no-first-run', '--no-default-browser-check'];

            if (cleanMode === 'incognito') {
                browser = await chromium.launch({ headless: isHeadless, args: isHeadless ? headlessArgs : [...headlessArgs, '--start-maximized'] });
                context = await browser.newContext(contextOptions);
                page = await context.newPage();
            } else {
                const profileDir = path.join(__dirname, 'chrome-profiles', `profile-${shortKey}`);
                context = await chromium.launchPersistentContext(profileDir, { headless: isHeadless, args: isHeadless ? headlessArgs : [...headlessArgs, '--start-maximized'], ...contextOptions });
                page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
            }

            if (viewport) await page.setViewportSize(viewport);
            await page.route('**/*', (route) => {
                if (['image', 'media', 'font'].includes(route.request().resourceType())) route.abort();
                else route.continue();
            });

            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    break;
                } catch (navError) {
                    if (attempt < 3) await page.waitForTimeout(5000);
                    else throw navError;
                }
            }

            const dwellTime = getRandomRange(campaign.config.dwellMin, campaign.config.dwellMax);
            if (campaign.config.humanActions) await simulateHuman(campaignId, page, campaign.config.randomLinks);
            await page.waitForTimeout(dwellTime * 1000);
            success = true;
            if (cleanMode === 'settings') await clearSettingsBrowserData(campaignId, context, shortKey);
            sendLog(campaignId, `[Key: ...${shortKey}] Luot truy cap hoan tat!`, 'success');
        }

    } catch (error) {
        sendLog(campaignId, `[Key: ...${shortKey}] Loi: ${error.message}`, 'error');
        success = false;
    } finally {
        try {
            if (campaign.config.browserMode !== 'request') {
                if (cleanMode === 'incognito') { if (browser) await browser.close(); }
                else { if (context) await context.close(); }
            }
        } catch (e) {}

        if (success) {
            campaign.successVisits++;
        } else {
            campaign.failedVisits++;
            const c = campaigns.get(campaignId);
            const nextAttempt = (job && Number.isInteger(job.attempt) ? job.attempt : 0) + 1;
            const retryAt = Date.now() + (c ? c.retryBackoffMs : 2000);
            if (c && c.status === 'running' && nextAttempt <= c.maxRetriesPerSlot && retryAt < c.endTime) {
                c.retryQueue.push({
                    slotId: job ? job.slotId : null,
                    attempt: nextAttempt,
                    dueAt: retryAt
                });
                sendLog(campaignId, `Tac vu that bai - se thu lai lan ${nextAttempt}/${c.maxRetriesPerSlot} truoc gio ket thuc.`, 'warn');
            }
        }

        campaign.activeWorkers--;

        // Cooldown sau khi xong: dung gia tri tu campaign config neu co, neu khong dung gia tri tu proxyConfigData, mac dinh 30s
        const kState = globalProxyPool.get(keyState.key);
        const campCd = campaign ? campaign.config.cooldownSec : null;
        const effectiveCdSec = (typeof campCd === 'number' && campCd >= 0) ? campCd : (proxyConfigData.cooldownSec ?? 30);
        const cooldownMs = effectiveCdSec * 1000;
        if (kState && kState.nextRequestAt <= Date.now()) {
            kState.nextRequestAt = Date.now() + cooldownMs;
        }
        releaseKey(keyState.key);

        sendLog(campaignId, `Hoan tat phien | Key: ...${shortKey}`, 'info');
        emitStats(campaignId);

        // Check completion
        const c = campaigns.get(campaignId);
        if (c && c.status === 'running') {
            if (c.successVisits >= c.targetLimit) {
                completeCampaign(campaignId, 'completed');
            } else if (Date.now() >= c.endTime && c.activeWorkers === 0) {
                completeCampaign(campaignId, 'expired');
            }
        }
    }
}

// ─── Campaign lifecycle ────────────────────────────────────────────────────────
function completeCampaign(campaignId, reason) {
    const campaign = campaigns.get(campaignId);
    if (!campaign) return;
    if (['stopped', 'completed', 'expired'].includes(campaign.status)) return;

    campaign.status = reason;
    campaign.actualEndTime = Date.now();
    if (!campaign.actualStartTime) campaign.actualStartTime = campaign.startTime || Date.now();

    const msgs = {
        completed: `Chien dich ${campaignId} HOAN THANH! ${campaign.successVisits}/${campaign.targetLimit} luot.`,
        expired: `Chien dich ${campaignId} HET GIO. ${campaign.successVisits}/${campaign.targetLimit} luot.`,
        stopped: `Chien dich ${campaignId} DA DUNG. ${campaign.successVisits}/${campaign.targetLimit} luot.`
    };
    sendLog(campaignId, msgs[reason] || `Campaign ${campaignId} ended: ${reason}`, reason === 'completed' ? 'success' : 'system');

    io.emit('status-update', { campaignId, status: campaign.status, isRunning: false });
    emitStats(campaignId);
    emitCampaignList();

    if (reason === 'completed') {
        notifyTelegramCampaignComplete(campaignId).catch(err => console.error(`[Telegram] Notify error:`, err.message));
    }
}

function stopCampaign(campaignId) {
    const campaign = campaigns.get(campaignId);
    if (!campaign) return;
    if (['stopped', 'completed', 'expired'].includes(campaign.status)) return;
    completeCampaign(campaignId, 'stopped');
}

// ─── Scheduler tick ────────────────────────────────────────────────────────────
async function prepareAndLaunchJob(campaignId, campaign, job) {
    // Do not start new work outside the configured window.
    if (Date.now() >= campaign.endTime) return false;

    const keyState = acquireKey(campaignId);
    if (!keyState) return false;

    try {
        const newProxy = await fetchNewProxy(campaignId, keyState);
        if (!newProxy) await fetchCurrentProxy(campaignId, keyState);

        if (keyState.currentProxy) {
            const newIp = keyState.currentProxy.realIpAddress;
            if (campaign.config.dedupIp && campaign.usedIps.has(newIp)) {
                sendLog(campaignId, `IP da dung: ${newIp}. Giu nguyen slot de thu lai sau.`, 'warn');
                campaign.dupIpsCount++;
                releaseKey(keyState.key);
                return false;
            }
            campaign.usedIps.add(newIp);
        }

        runVisitWorker(campaignId, keyState, job).catch(err => {
            sendLog(campaignId, `Loi worker: ${err.message}`, 'error');
        });
        return true;
    } catch (err) {
        releaseKey(keyState.key);
        throw err;
    }
}

// ─── Scheduler tick ────────────────────────────────────────────────────────────
async function scheduleTick(campaignId) {
    const campaign = campaigns.get(campaignId);
    if (!campaign) return;
    if (['stopped', 'completed', 'expired'].includes(campaign.status)) return;

    // setInterval can fire again while proxy/network preparation is still awaiting.
    // A per-campaign mutex prevents the same schedule slot being dispatched twice.
    if (campaign._tickRunning) return;
    campaign._tickRunning = true;

    try {
        const now = Date.now();

        if (campaign.successVisits >= campaign.targetLimit) {
            completeCampaign(campaignId, 'completed');
            return;
        }

        if (campaign.status === 'waiting') {
            if (now >= campaign.startTime) {
                campaign.status = 'running';
                campaign.actualStartTime = now;
                sendLog(campaignId, `Thoi diem bat dau da den! Chien dich ${campaignId} bat dau chay.`, 'system');
                io.emit('status-update', { campaignId, status: 'running', isRunning: true });
                emitCampaignList();
            } else {
                if (now - campaign.lastWaitingLogTime >= 30000) {
                    const diffMs = campaign.startTime - now;
                    sendLog(campaignId, `Cho bat dau vao luc ${campaign.config.startTimeStr || ''} (con ${Math.floor(diffMs / 60000)}p ${Math.floor((diffMs % 60000) / 1000)}s)...`, 'info');
                    campaign.lastWaitingLogTime = now;
                }
                emitStats(campaignId);
                return;
            }
        }

        // Hard stop: never dispatch a new slot after endTime.
        // Existing in-flight workers may finish, then the campaign becomes completed/expired.
        if (now >= campaign.endTime) {
            if (campaign.activeWorkers === 0) {
                completeCampaign(campaignId, campaign.successVisits >= campaign.targetLimit ? 'completed' : 'expired');
            }
            emitStats(campaignId);
            return;
        }

        // Remove retries that can no longer run inside the window.
        campaign.retryQueue = campaign.retryQueue.filter(r => r.dueAt < campaign.endTime);

        // Catch up due work, but keep a bounded launch rate per second.
        // activeWorkers is counted against target to prevent overshooting successes.
        const maxLaunchPerTick = 4;
        let launchedThisTick = 0;

        while (launchedThisTick < maxLaunchPerTick) {
            if (campaign.successVisits + campaign.activeWorkers >= campaign.targetLimit) break;
            if (Date.now() >= campaign.endTime) break;

            // Failed work gets priority, but only while there is still time to retry.
            const retryIndex = campaign.retryQueue.findIndex(r => r.dueAt <= Date.now());
            if (retryIndex >= 0) {
                const retryJob = campaign.retryQueue[retryIndex];
                const launched = await prepareAndLaunchJob(campaignId, campaign, retryJob);
                if (!launched) break;
                campaign.retryQueue.splice(retryIndex, 1);
                launchedThisTick++;
                continue;
            }

            if (campaign.scheduleIdx >= campaign.schedule.length) break;
            if (campaign.schedule[campaign.scheduleIdx] > Date.now()) break;

            const slotId = campaign.scheduleIdx;
            const launched = await prepareAndLaunchJob(campaignId, campaign, { slotId, attempt: 0 });
            if (!launched) break;

            // Advance only after a worker was actually accepted for this slot.
            campaign.scheduleIdx++;
            launchedThisTick++;
        }

        emitStats(campaignId);
    } finally {
        campaign._tickRunning = false;
    }
}

// ─── Auth middleware ───────────────────────────────────────────────────────────
initAdminAccount();

function getUserRole(username) {
    if (!username) return null;
    if (username === '1') return 'guest';
    return 'admin';
}

app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    req.sessionToken = cookies ? cookies.session_token : null;
    const sessVal = req.sessionToken ? activeSessions.get(req.sessionToken) : null;
    req.username = (sessVal && typeof sessVal === 'object') ? sessVal.username : sessVal;
    req.userRole = (sessVal && typeof sessVal === 'object') ? sessVal.role : getUserRole(req.username);
    req.isAuthenticated = !!req.username;
    next();
});

function requireAuth(req, res, next) {
    const isPublicPath = req.path === '/login.html' || req.path.startsWith('/css/') ||
        req.path === '/js/login.js' || req.path.startsWith('/api/login') ||
        req.path.startsWith('/socket.io/') || req.path === '/favicon.ico';
    if (isPublicPath) return next();
    if (!req.isAuthenticated) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, message: 'Unauthorized' });
        return res.redirect('/login.html');
    }
    if (req.path === '/login.html') return res.redirect('/');
    next();
}
app.use(requireAuth);

function requireAdmin(req, res, next) {
    if (req.userRole !== 'admin') {
        return res.status(403).json({ success: false, message: 'Tai khoan khach khong co quyen thuc hien thao tac nay.' });
    }
    next();
}

// ─── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/me', (req, res) => {
    res.json({ success: true, username: req.username, role: req.userRole });
});

app.post('/api/login', (req, res) => {
    const { username, password, rememberMe } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Vui long dien du thong tin.' });

    let role = null;
    if (verifyAdminCredentials(username, password)) {
        role = 'admin';
    } else if (String(username).trim() === '1' && String(password) === '1') {
        role = 'guest';
    }

    if (role) {
        const token = crypto.randomUUID();
        const userObj = { username, role };
        activeSessions.set(token, userObj); saveSessions();
        const cookieOptions = { httpOnly: true, path: '/', sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };
        if (rememberMe !== false) {
            cookieOptions.maxAge = 30 * 24 * 60 * 60 * 1000;
        }
        res.cookie('session_token', token, cookieOptions);
        return res.json({ success: true, role, username });
    }
    return res.status(401).json({ success: false, message: 'Tai khoan hoac mat khau khong chinh xac.' });
});

app.post('/api/logout', (req, res) => {
    if (req.sessionToken) { activeSessions.delete(req.sessionToken); saveSessions(); }
    res.clearCookie('session_token', { path: '/' });
    res.json({ success: true });
});

app.post('/api/change-password', requireAdmin, (req, res) => {
    const { newUsername, newPassword, currentPassword } = req.body;
    if (!newUsername || !newPassword || !currentPassword) return res.status(400).json({ success: false, message: 'Dien du thong tin.' });
    if (!verifyAdminCredentials(req.username, currentPassword)) return res.status(401).json({ success: false, message: 'Mat khau hien tai khong dung.' });
    try { updateAdminAccount(newUsername, newPassword); activeSessions.set(req.sessionToken, { username: newUsername, role: 'admin' }); return res.json({ success: true }); }
    catch (e) { return res.status(500).json({ success: false, message: 'Loi luu.' }); }
});

app.get('/api/auth-check', (req, res) => {
    if (req.isAuthenticated) return res.json({ success: true, username: req.username, role: req.userRole });
    return res.status(401).json({ success: false });
});

// Proxy Config
app.get('/api/proxy-config', (req, res) => res.json({ success: true, data: proxyConfigForRole(req.userRole) }));

app.post('/api/proxy-config', requireAdmin, (req, res) => {
    const { region, keys, cooldownSec } = req.body;
    if (!Array.isArray(keys)) return res.status(400).json({ success: false, message: 'keys phai la array.' });
    const cd = (typeof cooldownSec === 'number' && cooldownSec >= 0) ? cooldownSec : 30;
    proxyConfigData = { region: region || 'random', keys, cooldownSec: cd };
    saveProxyConfig(proxyConfigData);
    initProxyPool();
    console.log(`[ProxyConfig] Saved ${keys.length} keys, region: ${region}, cooldown: ${cd}s`);
    res.json({ success: true, message: `Da luu ${keys.length} proxy key(s). Cooldown: ${cd}s`, poolSize: globalProxyPool.size });
});

// Campaigns CRUD
app.get('/api/campaigns', (req, res) => {
    const list = [];
    for (const [id, c] of campaigns.entries()) {
        list.push({ id, name: c.config.name || `Chien dich ${id}`, targetUrl: c.config.targetUrl, status: c.status, successVisits: c.successVisits, failedVisits: c.failedVisits, targetLimit: c.targetLimit, startTimeStr: c.config.startTimeStr, endTimeStr: c.config.endTimeStr, config: c.config });
    }
    res.json({ success: true, data: list });
});

app.post('/api/campaigns', requireAdmin, (req, res) => {
    const config = { ...req.body };
    config.startTime = Number(config.startTime);
    config.endTime = Number(config.endTime);
    config.targetClicks = Number.parseInt(config.targetClicks, 10);
    config.dwellMin = Math.max(1, Number.parseInt(config.dwellMin, 10) || 2);
    config.dwellMax = Math.max(config.dwellMin, Number.parseInt(config.dwellMax, 10) || 5);
    config.scheduleMode = ['smart', 'even', 'custom'].includes(config.scheduleMode) ? config.scheduleMode : 'smart';
    if (Number.isFinite(Number(config.timezoneOffsetMinutes))) {
        config.timezoneOffsetMinutes = Math.max(-840, Math.min(840, Number(config.timezoneOffsetMinutes)));
    } else {
        config.timezoneOffsetMinutes = null;
    }

    if (!config.targetUrl || !Number.isFinite(config.startTime) || !Number.isFinite(config.endTime) || !Number.isInteger(config.targetClicks) || config.targetClicks < 1) {
        return res.status(400).json({ success: false, message: 'Thieu hoac sai truong bat buoc.' });
    }
    try {
        const parsedUrl = new URL(config.targetUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('unsupported protocol');
    } catch (e) {
        return res.status(400).json({ success: false, message: 'URL muc tieu khong hop le (chi ho tro http/https).' });
    }
    if (config.endTime <= config.startTime) {
        return res.status(400).json({ success: false, message: 'End time phai sau start time.' });
    }
    if (config.endTime <= Date.now()) {
        return res.status(400).json({ success: false, message: 'End time phai nam trong tuong lai.' });
    }
    const id = generateCampaignId();
    const state = createCampaignState(id, config);
    campaigns.set(id, state);
    saveCampaignConfig(id, config);

    sendLog(id, `Chien dich ${id} da duoc tao: ${config.targetUrl} | ${config.targetClicks} luot | ${config.startTimeStr} -> ${config.endTimeStr}`, 'system');
    io.emit('status-update', { campaignId: id, status: state.status, isRunning: ['running', 'waiting'].includes(state.status) });
    emitCampaignList();
    emitStats(id);

    res.status(201).json({ success: true, id });
});

app.delete('/api/campaigns/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    if (!campaigns.has(id)) return res.status(404).json({ success: false, message: 'Khong tim thay.' });
    if (['running', 'waiting'].includes(campaigns.get(id).status)) stopCampaign(id);
    campaigns.delete(id);
    deleteCampaignFile(id);
    io.emit('campaign-deleted', { campaignId: id });
    emitCampaignList();
    res.json({ success: true });
});

app.post('/api/campaigns/:id/stop', requireAdmin, (req, res) => {
    const id = req.params.id;
    if (!campaigns.has(id)) return res.status(404).json({ success: false, message: 'Khong tim thay.' });
    stopCampaign(id);
    res.json({ success: true });
});

app.post('/api/campaigns/:id/reset-stats', requireAdmin, (req, res) => {
    const id = req.params.id;
    const campaign = campaigns.get(id);
    if (!campaign) return res.status(404).json({ success: false });
    campaign.totalVisits = 0; campaign.successVisits = 0;
    campaign.failedVisits = 0; campaign.usedIps = new Set(); campaign.dupIpsCount = 0;
    sendLog(id, `Reset thong ke Chien dich ${id}.`, 'system');
    emitStats(id);
    res.json({ success: true });
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ─── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const sessionToken = cookies ? cookies.session_token : null;
    const sessVal = sessionToken ? activeSessions.get(sessionToken) : null;
    const socketUsername = (sessVal && typeof sessVal === 'object') ? sessVal.username : sessVal;
    const socketRole = (sessVal && typeof sessVal === 'object') ? sessVal.role : getUserRole(socketUsername);

    console.log(`Socket connected: ${socket.id} (${socketUsername || 'anon'} [${socketRole}])`);

    if (!socketUsername) {
        socket.emit('auth-required');
        socket.disconnect(true);
        return;
    }

    socket.emit('user-info', { username: socketUsername, role: socketRole });
    socket.emit('proxy-config', proxyConfigForRole(socketRole));
    const campaignList = [];
    for (const [id, c] of campaigns.entries()) {
        campaignList.push({ id, name: c.config.name || `Chien dich ${id}`, targetUrl: c.config.targetUrl, status: c.status, successVisits: c.successVisits, targetLimit: c.targetLimit, startTimeStr: c.config.startTimeStr, endTimeStr: c.config.endTimeStr, config: c.config });
        socket.emit('status-update', { campaignId: id, status: c.status, isRunning: ['running', 'waiting'].includes(c.status) });
        emitStats(id);
    }
    socket.emit('campaigns-list', campaignList);

    socket.on('stop-campaign', ({ campaignId }) => {
        if (socketRole !== 'admin') return;
        try { stopCampaign(campaignId); } catch (e) {}
    });

    socket.on('reset-stats', ({ campaignId }) => {
        if (socketRole !== 'admin') return;
        const campaign = campaigns.get(campaignId);
        if (campaign) {
            campaign.totalVisits = 0; campaign.successVisits = 0;
            campaign.failedVisits = 0; campaign.usedIps = new Set(); campaign.dupIpsCount = 0;
            sendLog(campaignId, `Reset thong ke Chien dich ${campaignId}.`, 'system');
            emitStats(campaignId);
        }
    });

    socket.on('disconnect', () => console.log(`Socket disconnected: ${socket.id}`));
});

// ─── Global scheduler ──────────────────────────────────────────────────────────
setInterval(() => {
    for (const [id] of campaigns.entries()) {
        scheduleTick(id).catch(err => console.error(`Scheduler Error C${id}:`, err.message));
    }
}, 1000);

// ─── Startup ───────────────────────────────────────────────────────────────────
migrateOldConfigs();
loadCampaignsFromDisk();

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nTraffic Control System running at http://localhost:${PORT}`);
    console.log(`Campaigns: ${campaigns.size} loaded | Proxy Pool: ${globalProxyPool.size} key(s)\n`);
});
