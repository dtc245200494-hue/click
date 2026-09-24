const socket = io();
const states = new Map();
const form = document.getElementById('campaign-form');
const campaignsEl = document.getElementById('campaigns');
const logsEl = document.getElementById('logs');
const errorEl = document.getElementById('error');
const previewEl = document.getElementById('preview');

function localValue(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const now = new Date();
document.getElementById('startTime').value = localValue(new Date(now.getTime() + 60_000));
document.getElementById('endTime').value = localValue(new Date(now.getTime() + 5 * 3600_000));

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function render() {
  const rows = [...states.values()].sort((a, b) => a.startTime - b.startTime);
  campaignsEl.innerHTML = rows.length ? rows.map(c => `
    <article class="campaign">
      <div class="campaign-head">
        <div><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.targetUrl)}</small></div>
        <span class="status ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span>
      </div>
      <div class="stats">
        <span><b>${c.attempted}</b>/${c.targetRequests} sent</span>
        <span><b>${c.success}</b> success</span>
        <span><b>${c.failed}</b> fail</span>
        <span><b>${c.activeWorkers}</b> active</span>
        <span>p95 <b>${c.p95ApproxMs ?? '--'}</b> ms</span>
      </div>
      <div class="bar"><i style="width:${Math.min(100, c.targetRequests ? c.attempted / c.targetRequests * 100 : 0)}%"></i></div>
      ${['waiting','running'].includes(c.status) ? `<button class="danger" onclick="stopCampaign('${c.id}')">Dừng</button>` : ''}
    </article>`).join('') : '<p class="muted">Chưa có campaign.</p>';
}

async function refresh() {
  const res = await fetch('/api/campaigns');
  for (const item of await res.json()) states.set(item.id, item);
  render();
}

globalThis.stopCampaign = async (id) => {
  await fetch(`/api/campaigns/${id}/stop`, { method: 'POST' });
};

document.getElementById('refresh').addEventListener('click', refresh);

async function updatePreview() {
  const start = new Date(document.getElementById('startTime').value).getTime();
  const end = new Date(document.getElementById('endTime').value).getTime();
  const target = Number(document.getElementById('targetRequests').value || 0);
  if (!start || !end || !target || end <= start) { previewEl.textContent = ''; return; }
  const params = new URLSearchParams({
    startTime: start,
    endTime: end,
    targetRequests: target,
    mode: document.getElementById('mode').value,
    timezoneOffsetMinutes: new Date().getTimezoneOffset()
  });
  const dist = await fetch('/api/preview?' + params).then(r => r.json());
  if (!dist.valid) { previewEl.textContent = ''; return; }
  previewEl.innerHTML = dist.slices.map(s => `<span>${String(s.hour).padStart(2,'0')}h: <b>${s.quota}</b></span>`).join('');
}
for (const id of ['startTime','endTime','targetRequests','mode']) document.getElementById(id).addEventListener('input', updatePreview);
updatePreview();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  const body = {
    name: document.getElementById('name').value,
    targetUrl: document.getElementById('targetUrl').value,
    startTime: new Date(document.getElementById('startTime').value).getTime(),
    endTime: new Date(document.getElementById('endTime').value).getTime(),
    targetRequests: Number(document.getElementById('targetRequests').value),
    concurrency: Number(document.getElementById('concurrency').value),
    mode: document.getElementById('mode').value,
    timezoneOffsetMinutes: new Date().getTimezoneOffset()
  };
  const res = await fetch('/api/campaigns', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { errorEl.textContent = data.error || 'Không tạo được campaign.'; return; }
  states.set(data.id, data); render();
});

socket.on('campaigns-snapshot', items => { for (const c of items) states.set(c.id, c); render(); });
socket.on('campaign-update', c => { states.set(c.id, c); render(); });
socket.on('campaign-log', item => {
  const div = document.createElement('div');
  div.className = item.type || 'info';
  div.textContent = `[${new Date(item.at).toLocaleTimeString()}] ${item.campaignId.slice(0,8)} ${item.message}`;
  logsEl.prepend(div);
  while (logsEl.children.length > 100) logsEl.lastChild.remove();
});
refresh();
