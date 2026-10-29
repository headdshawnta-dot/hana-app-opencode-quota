import { hana } from './sdk.js';

const subEl = document.getElementById('sub');
const sectionsEl = document.getElementById('sections');
const stampEl = document.getElementById('stamp');
const refreshBtn = document.getElementById('refresh');

const REFRESH_MS = 60_000;

const TITLES = {
  NO_KEY: '还没配钥匙',
  KEY_MALFORMED: '这栏里不是钥匙',
  KEY_MASKED: '存进去的是掩码',
  KEY_INVALID: '钥匙失效了',
  NO_ACCESS: '没有访问权限',
  ENDPOINT_MOVED: '接口搬家了',
  RATE_LIMITED: '请求太频繁',
  NETWORK: '网络没通',
  BAD_PAYLOAD: '返回格式变了',
  EMPTY_PAYLOAD: '返回里没有数据',
  SURFACE_EXPIRED: '卡片会话过期了',
};

let state = null;
let ticking = null;
let pollTimer = null;
let inFlight = false;

/** 倒计时压成缩写：3天23h / 1h39m / 42m，仪表盘不该写成句子。 */
function shortCountdown(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds <= 0) return '即将重置';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

function formatClock(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const dt = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())} 更新`;
}

function buildRow(win, sectionId) {
  const row = document.createElement('div');
  row.className = 'row';
  row.title = win.note ?? '';

  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = win.label;

  const bar = document.createElement('div');
  bar.className = 'row-bar';
  const fill = document.createElement('div');
  fill.className = `fill ${win.level}`;
  fill.style.width = `${Math.max(win.percent, 1.5)}%`;
  bar.append(fill);

  const pct = document.createElement('span');
  pct.className = `row-pct ${win.level}`;
  pct.textContent = `${win.percent}%`;

  const reset = document.createElement('span');
  reset.className = 'row-reset';
  reset.dataset.reset = `${sectionId}:${win.key}`;
  reset.textContent = shortCountdown(win.secondsLeft);

  row.append(label, bar, pct, reset);
  return row;
}

function buildSection(section) {
  const block = document.createElement('section');
  block.className = 'block';

  const head = document.createElement('div');
  head.className = 'block-head';

  const title = document.createElement('span');
  title.className = 'block-title';
  title.textContent = section.title;
  head.append(title);

  if (section.ok && section.account) {
    const who = document.createElement('span');
    who.className = 'block-who';
    who.textContent = section.account;
    head.append(who);
  }
  block.append(head);

  if (!section.ok) {
    const err = document.createElement('p');
    err.className = 'block-error';
    err.textContent = TITLES[section.code] ? `${TITLES[section.code]}：${section.message}` : section.message;
    block.append(err);
    return block;
  }

  for (const win of section.windows) block.append(buildRow(win, section.id));

  const facts = [];
  if (section.credits) {
    const c = section.credits;
    facts.push(
      c.pool
        ? `余额 $${c.remaining.toFixed(2)} / $${c.pool.toFixed(2)}`
        : `余额 $${c.remaining.toFixed(2)}`,
    );
  }
  if (section.subscription?.plan) facts.push(`套餐 ${section.subscription.plan}`);
  if (facts.length > 0) {
    const line = document.createElement('p');
    line.className = 'block-facts';
    line.textContent = facts.join(' · ');
    block.append(line);
  }

  return block;
}

function render(result) {
  state = result;
  sectionsEl.replaceChildren(...result.sections.map(buildSection));

  const all = result.sections.filter((s) => s.ok).flatMap((s) => s.windows);
  if (all.length === 0) {
    subEl.textContent = '两段都没取到数，下面写的是原因。';
  } else {
    const tight = all.reduce((a, b) => (b.percent > a.percent ? b : a));
    subEl.textContent =
      tight.percent >= 90
        ? `最紧的${tight.label}窗口 ${tight.percent}%`
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
    if (!state?.sections) return;
    for (const section of state.sections) {
      if (!section.ok) continue;
      for (const win of section.windows) {
        if (win.secondsLeft === null) continue;
        win.secondsLeft = Math.max(0, win.secondsLeft - 1);
        const el = sectionsEl.querySelector(`[data-reset="${section.id}:${win.key}"]`);
        if (el) el.textContent = shortCountdown(win.secondsLeft);
      }
    }
  }, 1000);
}

function fatal(code, message) {
  return {
    ok: false,
    sections: [{ id: 'local', title: '本地', ok: false, code, message }],
    fetchedAt: new Date().toISOString(),
  };
}

async function load() {
  if (inFlight) return;
  inFlight = true;
  refreshBtn.disabled = true;
  try {
    const res = await hana.api.fetch('/quota', { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      if (res.status === 403) {
        render(
          fatal(
            'SURFACE_EXPIRED',
            '这张卡片和后台之间的会话过期了（挂太久会出现）。关掉卡片重新打开，或重载应用即可恢复。',
          ),
        );
        return;
      }
      render(fatal('HTTP_' + res.status, '本地后端没响应这个请求（' + res.status + '）。'));
      return;
    }
    render(await res.json());
  } catch (error) {
    render(fatal('NETWORK', '连不上应用自己的后端：' + (error?.message ?? String(error))));
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
