import { hana } from './sdk.js';

const subEl = document.getElementById('sub');
const windowsEl = document.getElementById('windows');
const errorEl = document.getElementById('error');
const errorTitleEl = document.getElementById('error-title');
const errorBodyEl = document.getElementById('error-body');
const errorCodeEl = document.getElementById('error-code');
const stampEl = document.getElementById('stamp');
const refreshBtn = document.getElementById('refresh');

const REFRESH_MS = 5 * 60_000;

let state = null;
let ticking = null;
let pollTimer = null;
let inFlight = false;

const TITLES = {
  NO_KEY: '还没配钥匙',
  KEY_MALFORMED: '这栏里不是钥匙',
  KEY_MASKED: '存进去的是掩码',
  KEY_INVALID: '钥匙失效了',
  NO_SUBSCRIPTION: '没有 Go 计划权限',
  ENDPOINT_MOVED: '接口搬家了',
  RATE_LIMITED: '请求太频繁',
  NETWORK: '网络没通',
  SURFACE_EXPIRED: '卡片会话过期了',
  BAD_PAYLOAD: '返回格式变了',
  EMPTY_PAYLOAD: '返回里没有数据',
};

function formatCountdown(seconds) {
  if (seconds === null || seconds === undefined) return '重置时间未知';
  if (seconds <= 0) return '马上重置';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d} 天 ${h} 小时后重置` : `${d} 天后重置`;
  if (h > 0) return `${h} 小时 ${m} 分后重置`;
  if (m > 0) return `${m} 分钟后重置`;
  return `${seconds} 秒后重置`;
}

function formatClock(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const dt = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())} 更新`;
}

function buildWindow(win) {
  const wrap = document.createElement('div');
  wrap.className = 'win';

  const top = document.createElement('div');
  top.className = 'win-top';

  const label = document.createElement('span');
  label.className = 'win-label';
  label.textContent = win.label;

  const pct = document.createElement('span');
  pct.className = `win-pct ${win.level}`;
  pct.innerHTML = `${win.percent}<small>%</small>`;

  top.append(label, pct);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.className = `fill ${win.level}`;
  fill.style.width = `${Math.max(win.percent, 1.5)}%`;
  bar.append(fill);

  const note = document.createElement('p');
  note.className = 'win-note';
  const tip = document.createElement('span');
  tip.textContent = win.note ?? '';
  const reset = document.createElement('span');
  reset.className = 'reset';
  reset.dataset.reset = win.key;
  reset.textContent = formatCountdown(win.secondsLeft);
  note.append(tip, reset);

  wrap.append(top, bar, note);
  return wrap;
}

function render(result) {
  state = result;
  errorEl.hidden = true;
  windowsEl.hidden = false;

  if (!result.ok) {
    windowsEl.hidden = true;
    windowsEl.replaceChildren();
    errorEl.hidden = false;
    errorTitleEl.textContent = TITLES[result.code] ?? '查不到额度';
    errorBodyEl.textContent = result.message;
    errorCodeEl.textContent = result.code;
    subEl.textContent = '数据没拿到，下面写的是原因。';
  } else {
    windowsEl.replaceChildren(...result.windows.map(buildWindow));
    const tight = result.tightest;
    subEl.textContent =
      tight.percent >= 90
        ? `最紧的是${tight.label}窗口，已经 ${tight.percent}%`
        : tight.percent >= 70
          ? `${tight.label}窗口 ${tight.percent}%，注意着点`
          : `都在安全区内，最紧的${tight.label}才 ${tight.percent}%`;
  }

  stampEl.textContent = result.fetchedAt ? formatClock(result.fetchedAt) : '—';
  startTicking();
}

function startTicking() {
  if (ticking) return;
  ticking = setInterval(() => {
    if (!state?.ok) return;
    for (const win of state.windows) {
      if (win.secondsLeft === null) continue;
      win.secondsLeft = Math.max(0, win.secondsLeft - 1);
      const el = windowsEl.querySelector(`[data-reset="${win.key}"]`);
      if (el) el.textContent = formatCountdown(win.secondsLeft);
    }
  }, 1000);
}

async function load() {
  if (inFlight) return;
  inFlight = true;
  refreshBtn.disabled = true;
  try {
    const res = await hana.api.fetch('/quota', { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      // 403 几乎总是卡片自己的会话过期，而不是后端出错：
      // 卡片挂久了，宿主发给 iframe 的 surface session 会失效，
      // 直到这个文档重新 mount 才会换新的。
      if (res.status === 403) {
        render({
          ok: false,
          code: 'SURFACE_EXPIRED',
          message: '这张卡片和后台之间的会话过期了（卡片挂太久会出现）。关掉这张卡片重新打开，或者在设置里重载一次应用，就能恢复。',
          fetchedAt: new Date().toISOString(),
        });
        return;
      }
      render({
        ok: false,
        code: 'HTTP_' + res.status,
        message: '本地后端没响应这个请求（' + res.status + '）。',
        fetchedAt: new Date().toISOString(),
      });
      return;
    }
    render(await res.json());
  } catch (error) {
    render({
      ok: false,
      code: 'NETWORK',
      message: '连不上应用自己的后端：' + (error?.message ?? String(error)),
      fetchedAt: new Date().toISOString(),
    });
  } finally {
    inFlight = false;
    refreshBtn.disabled = false;
  }
}

function schedule() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, REFRESH_MS);
}

refreshBtn.addEventListener('click', load);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

await hana.ready();
await load();
schedule();
