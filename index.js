import { defineApp } from "./sdk/app-contract/server-client.js";

const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CC_API_BASE = "https://api.commandcode.ai";

const OPENCODE_LABELS = { rolling: "5 小时", weekly: "本周", monthly: "本月" };
const OPENCODE_NOTES = {
  rolling: "滚动 5 小时窗口，用满会直接卡住",
  weekly: "本周窗口",
  monthly: "月额度，所有窗口的基准",
};

const CC_LABELS = { fiveHour: "5 小时", weekly: "本周" };
const CC_NOTES = {
  fiveHour: "滚动 5 小时窗口",
  weekly: "本周窗口",
};

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function resetMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1e12 ? Math.round(value / 1000) : value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const raw = value.trim();
    const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed >= 1e12 ? Math.round(parsed / 1000) : parsed;
  }
  return null;
}

/** 把 key 形状问题挡在发请求之前，别让浏览器抛字节错误。 */
function keyProblem(raw, label) {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key === "") {
    return { code: "NO_KEY", message: "还没填 " + label + " 的 key。" };
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    const bad = [...key].find((ch) => ch.codePointAt(0) > 0x7e);
    const where = bad
      ? "第 " + (key.indexOf(bad) + 1) + " 个字符是「" + bad + "」"
      : "里面有空格或不可见字符";
    return {
      code: "KEY_MALFORMED",
      message:
        label + " 的 key 那一栏存的不是一串 key（" + where + "）。整栏清空后重新粘贴纯英文的那一串。",
    };
  }
  if (/^\*+$/.test(key)) {
    return {
      code: "KEY_MASKED",
      message: label + " 的 key 读到的是掩码，真正的值没存进去。重新粘贴一次再保存。",
    };
  }
  return null;
}

function httpProblem(status, label) {
  if (status === 401) {
    return { code: "KEY_INVALID", message: label + " 的 key 无效或已过期。" };
  }
  if (status === 403) {
    return {
      code: "NO_ACCESS",
      message: label + " 拒绝了这个 key，可能是订阅过期，或者 key 属于别的工作区。",
    };
  }
  if (status === 404) {
    return { code: "ENDPOINT_MOVED", message: label + " 的额度接口不见了，需要更新这个应用。" };
  }
  if (status === 429) {
    return { code: "RATE_LIMITED", message: label + " 请求太频繁，等一会儿再试。" };
  }
  return { code: "HTTP_" + status, message: label + " 返回了 " + status + "。" };
}

function toWindow(key, label, note, percent, resetsAt, nowMs, warn, danger) {
  const reset = resetsAt ? Date.parse(resetsAt) : NaN;
  return {
    key,
    label,
    note,
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    resetsAt,
    secondsLeft: Number.isFinite(reset) ? Math.max(0, Math.round((reset - nowMs) / 1000)) : null,
    level: percent >= danger ? "danger" : percent >= warn ? "warn" : "ok",
  };
}

async function readLimits(sdk) {
  return {
    warn: num(await sdk.config.get("warnPercent")) ?? 70,
    danger: num(await sdk.config.get("dangerPercent")) ?? 90,
  };
}

async function fetchOpencode(sdk, nowMs, warn, danger) {
  const problem = keyProblem(await sdk.config.get("apiKey"), "OpenCode");
  if (problem) return { id: "opencode", title: "OpenCode", ok: false, ...problem };

  let response;
  try {
    response = await sdk.network.fetch(OPENCODE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + (await sdk.config.get("apiKey")).trim(),
        Accept: "application/json",
      },
      timeoutMs: 15000,
      maxResponseBytes: 65536,
    });
  } catch (error) {
    return {
      id: "opencode",
      title: "OpenCode",
      ok: false,
      code: "NETWORK",
      message: "请求没能发出去：" + (error?.message ?? String(error)),
    };
  }

  if (!response.ok) {
    return { id: "opencode", title: "OpenCode", ok: false, ...httpProblem(response.status, "OpenCode") };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      id: "opencode",
      title: "OpenCode",
      ok: false,
      code: "BAD_PAYLOAD",
      message: "接口返回的不是 JSON，可能已经改版了。",
    };
  }

  const usage = asRecord(payload?.usage);
  const windows = [];
  for (const key of ["rolling", "weekly", "monthly"]) {
    const percent = num(usage?.[key]?.percent);
    if (percent === null) continue;
    windows.push(
      toWindow(
        key,
        OPENCODE_LABELS[key],
        OPENCODE_NOTES[key],
        percent,
        str(usage?.[key]?.resetsAt),
        nowMs,
        warn,
        danger,
      ),
    );
  }

  if (windows.length === 0) {
    return {
      id: "opencode",
      title: "OpenCode",
      ok: false,
      code: "EMPTY_PAYLOAD",
      message: "接口通了，但里面没有用量数据，字段可能被改名了。",
    };
  }

  return { id: "opencode", title: "OpenCode", ok: true, windows };
}

async function ccGet(sdk, path) {
  const response = await sdk.network.fetch(CC_API_BASE + path, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + (await sdk.config.get("commandCodeKey")).trim(),
      Accept: "application/json",
    },
    timeoutMs: 15000,
    maxResponseBytes: 65536,
  });
  if (!response.ok) {
    const error = new Error("http " + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchCommandCode(sdk, nowMs, warn, danger) {
  const base = { id: "commandcode", title: "Command Code" };
  const problem = keyProblem(await sdk.config.get("commandCodeKey"), "Command Code");
  if (problem) return { ...base, ok: false, ...problem };

  let whoami;
  try {
    whoami = await ccGet(sdk, "/alpha/whoami");
  } catch (error) {
    if (error?.status) return { ...base, ok: false, ...httpProblem(error.status, "Command Code") };
    return {
      ...base,
      ok: false,
      code: "NETWORK",
      message: "请求没能发出去：" + (error?.message ?? String(error)),
    };
  }

  const org = asRecord(whoami?.org);
  const user = asRecord(whoami?.user);
  const orgId = org ? str(org.id) : null;
  const account = (org ? str(org.login) : null) ?? (user ? str(user.userName) : null);
  // 用 URLSearchParams 拼参数：org 为 null 时不能把 &since 直接接在路径后面。
  const query = (extra) => {
    const params = new URLSearchParams();
    if (orgId) params.set("orgId", orgId);
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (value) params.set(key, value);
    }
    const text = params.toString();
    return text ? "?" + text : "";
  };

  // 余额和套餐各自可能拿不到，缺一块不该让整段变红。
  let credits = null;
  let subscription = null;
  let summary = null;
  let ccWindowsRaw = null;
  try {
    const raw = await ccGet(sdk, "/alpha/billing/credits" + query());
    const c = asRecord(raw?.credits);
    if (c) {
      const monthly = num(c.monthlyCredits) ?? 0;
      const purchased = num(c.purchasedCredits) ?? 0;
      const free = num(c.freeCredits) ?? 0;
      credits = { remaining: monthly + purchased + free, monthly, purchased, free };
    }
    const limits = asRecord(raw?.windowLimits);
    if (limits) ccWindowsRaw = limits;
  } catch {
    credits = null;
  }

  try {
    const raw = await ccGet(sdk, "/alpha/billing/subscriptions" + query());
    const data = asRecord(raw?.data);
    if (data) {
      subscription = {
        plan: str(data.planId),
        status: str(data.status),
        periodStart: str(data.currentPeriodStart),
        periodEnd: str(data.currentPeriodEnd),
      };
    }
  } catch {
    subscription = null;
  }

  // 月度额度不是第三个窗口，而是「已用金额 ÷ (已用 + 剩余)」算出来的池子。
  try {
    const raw = await ccGet(
      sdk,
      "/alpha/usage/summary" + query({ since: subscription?.periodStart }),
    );
    const cost = num(raw?.totalCost);
    if (cost !== null) {
      summary = { totalCost: cost, totalCount: num(raw?.totalCount) };
    }
  } catch {
    summary = null;
  }

  const windows = [];
  for (const key of ["fiveHour", "weekly"]) {
    const entry = asRecord(ccWindowsRaw?.[key]);
    if (!entry) continue;
    const used = num(entry.used);
    const cap = num(entry.cap);
    if (used === null || cap === null || cap <= 0) continue;
    const reset = resetMs(entry.resetAt);
    // resetAt 为 0 表示这个窗口当前没有任何用量，也就没有可报的重置点。
    const resetIso = reset !== null && reset > 0 ? new Date(reset * 1000).toISOString() : null;
    const win = toWindow(
      key,
      CC_LABELS[key],
      CC_NOTES[key],
      (used / cap) * 100,
      resetIso,
      nowMs,
      warn,
      danger,
    );
    // 窗口空着：没有重置时间可报，但不代表数据缺失。
    if (resetIso === null && used === 0) win.idle = true;
    windows.push(win);
  }

  if (windows.length === 0 && !credits && !subscription) {
    return {
      ...base,
      ok: false,
      code: "EMPTY_PAYLOAD",
      message: "接口通了，但既没有窗口用量也没有余额，字段可能被改名了。",
    };
  }

  // 月度那一行：已用 / (已用 + 剩余)，重置时间取订阅周期结束。
  if (credits && summary && summary.totalCost >= 0) {
    const spent = summary.totalCost;
    const pool = credits.remaining + spent;
    if (pool > 0) {
      credits.spent = spent;
      credits.pool = pool;
      windows.push(
        toWindow(
          "monthly",
          "本月",
          "已用金额占本月额度池的比例",
          (spent / pool) * 100,
          subscription?.periodEnd ?? null,
          nowMs,
          warn,
          danger,
        ),
      );
    }
  }

  return {
    ...base,
    ok: true,
    account,
    windows,
    credits,
    subscription,
    partial: windows.length === 0,
  };
}

async function fetchAll(sdk) {
  const nowMs = Date.now();
  const { warn, danger } = await readLimits(sdk);
  const sections = [];
  sections.push(await fetchOpencode(sdk, nowMs, warn, danger));
  sections.push(await fetchCommandCode(sdk, nowMs, warn, danger));
  return { ok: true, sections, fetchedAt: new Date(nowMs).toISOString() };
}

function formatDuration(seconds) {
  if (seconds === null) return "重置时间未知";
  if (seconds <= 0) return "即将重置";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? days + " 天 " + hours + " 小时" : days + " 天";
  if (hours > 0) return hours + " 小时 " + minutes + " 分";
  return minutes + " 分钟";
}

function sectionText(section) {
  if (!section.ok) return section.title + "：查不到，" + section.message;
  const parts = [];
  if (section.windows.length > 0) {
    parts.push(
      section.windows
        .map((w) => {
          const left =
            w.secondsLeft === null
              ? ""
              : w.secondsLeft <= 0
                ? "，即将重置"
                : "，" + formatDuration(w.secondsLeft) + "后重置";
          return w.label + " " + w.percent + "%" + left;
        })
        .join("；"),
    );
  }
  if (section.credits) {
    const c = section.credits;
    parts.push(
      c.pool ? "余额 $" + c.remaining.toFixed(2) + " / $" + c.pool.toFixed(2) : "余额 $" + c.remaining.toFixed(2),
    );
  }
  if (section.subscription?.plan) parts.push("套餐 " + section.subscription.plan);
  return section.title + "：" + parts.join("，");
}

// ---------- 输出速度计 ----------
//
// 两条数据路：message_update 的文本增量，实时但只有字符数；llm_usage 的账目，
// 精确但请求结束才到。字符按中英分别折算成 token，折算系数再用真实用量回校，
// 所以中文英文混排也不会一直偏。

const SPEED_WINDOW_MS = 2000;
const SPEED_IDLE_MS = 1200;
const SPEED_PILL_MS = 900;
const SPEED_KEEP_MS = 60000;

/** 中文（含日韩汉字）算一个 token，西文按 3.6 字符一个 token 折。 */
export function estimateTokens(text) {
  let tok = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff)
    ) {
      tok += 1;
    } else {
      tok += 1 / 3.6;
    }
  }
  return tok;
}

export function createSpeedMeter(sdk) {
  const meters = new Map();
  const idCache = new Map();
  const missCache = new Map();
  const pillByPath = new Map();
  const lookupErrors = new Map();
  let calibRatio = 1;
  let calibSamples = 0;
  let lastFinished = null;
  let pillTimer = null;
  let pillBusy = false;
  let lastPill = null;

  function latest(now) {
    let best = null;
    for (const m of meters.values()) {
      if (now - m.lastAt > SPEED_KEEP_MS) continue;
      if (!best || m.lastAt > best.lastAt) best = m;
    }
    return best;
  }

  /** 空了一段时间就把这一段算结束，下一次增量重新从零开计，不跨轮累加。 */
  function settle(now) {
    for (const m of meters.values()) {
      if (m.active && now - m.lastAt > SPEED_IDLE_MS) m.active = false;
    }
  }

  function windowSpeed(m, now) {
    const cutoff = now - SPEED_WINDOW_MS;
    m.buckets = m.buckets.filter((b) => b.t >= cutoff);
    if (m.buckets.length === 0) return 0;
    const from = Math.max(m.startedAt || cutoff, cutoff);
    const span = Math.max(0.4, (now - from) / 1000);
    let tok = 0;
    for (const b of m.buckets) tok += b.tok;
    return tok / span;
  }

  function onDelta(path, delta) {
    const text = typeof delta?.delta === "string" ? delta.delta : "";
    if (text === "") return;
    const now = Date.now();
    let m = meters.get(path);
    if (!m) {
      m = {
        path,
        sessionId: null,
        startedAt: 0,
        lastAt: 0,
        buckets: [],
        raw: 0,
        tokens: 0,
        active: false,
        modelId: null,
        deltas: 0,
      };
      meters.set(path, m);
    }
    if (!m.active) {
      m.active = true;
      m.startedAt = now;
      m.raw = 0;
      m.tokens = 0;
      m.buckets = [];
    }
    m.lastAt = now;
    m.deltas += 1;
    const base = estimateTokens(text);
    m.raw += base;
    const tok = base * calibRatio;
    m.tokens += tok;
    m.buckets.push({ t: now, tok });
    queuePill();
  }

  function onUsage(entry) {
    const usage = asRecord(entry?.usage);
    const out = asRecord(usage?.output);
    const total = num(out?.totalTokens);
    if (total === null) return;
    const ms = num(entry?.durationMs);
    const sid = str(entry?.attribution?.sessionId);
    let target = null;
    if (sid) {
      for (const m of meters.values()) if (m.sessionId === sid) target = m;
    }
    if (!target) {
      const near = latest(Date.now());
      if (near && near.raw > 0) target = near;
    }
    if (target && target.raw > 0) {
      const ratio = total / target.raw;
      if (ratio > 0.25 && ratio < 4) {
        calibRatio = calibSamples === 0 ? ratio : calibRatio * 0.7 + ratio * 0.3;
        calibSamples += 1;
      }
    }
    // 账目里的 durationMs 常常是 0，指不上；那就用我们自己看到这段流的起讫时间，
    // 分子仍然是真实 token，所以这个数依然贴着实测。
    let usableMs = ms !== null && ms > 200 ? ms : null;
    if (usableMs === null && target && target.startedAt && target.lastAt > target.startedAt) {
      const span = target.lastAt - target.startedAt;
      if (span >= 200) usableMs = span;
    }
    const exactTps = usableMs !== null && usableMs > 0 ? total / (usableMs / 1000) : null;
    lastFinished = {
      tokens: total,
      reasoningTokens: num(out?.reasoningTokens),
      tps: exactTps,
      ms: usableMs,
      cacheHitRatio: num(asRecord(usage?.cache)?.hitRatio),
      modelId: str(entry?.model?.modelId),
      at: new Date().toISOString(),
    };
    queuePill();
  }

  function snapshot() {
    const now = Date.now();
    settle(now);
    const m = latest(now);
    const streaming = Boolean(m && now - m.lastAt < SPEED_IDLE_MS);
    return {
      ok: true,
      streaming,
      tps: streaming && m ? windowSpeed(m, now) : 0,
      tokens: streaming && m ? Math.round(m.tokens) : 0,
      avgTps: streaming && m && m.startedAt ? m.tokens / Math.max(0.5, (m.lastAt - m.startedAt) / 1000) : null,
      modelId: m?.modelId ?? null,
      last: lastFinished,
      calibration: { ratio: calibRatio, samples: calibSamples },
      pill: lastPill,
      seen: seenPaths(now),
    };
  }

  function seenPaths(now) {
    const rows = [];
    for (const m of meters.values()) {
      rows.push({
        path: m.path,
        deltas: m.deltas,
        active: m.active,
        agoMs: now - m.lastAt,
        sessionId: m.sessionId,
        lookupError: lookupErrors.get(m.path) ?? null,
        pill: pillByPath.get(m.path) ?? null,
      });
    }
    rows.sort((a, b) => a.agoMs - b.agoMs);
    return rows.slice(0, 6);
  }

  async function sessionIdFor(path) {
    if (!path) return null;
    if (idCache.has(path)) return idCache.get(path);
    const now = Date.now();
    const miss = missCache.get(path);
    if (miss && now - miss < 10000) return null;

    let sid = null;
    // 先按路径直接问。session:list 只看 home 和 app 两类会话，code 模式的会话不在里面，
    // 而 session:get 是按路径在全部会话里查的。scope 必须显式写 all：
    // 默认是 own，意思是“这个会话属不属于本应用”，别的 agent 的会话一定不过。
    try {
      const res = await sdk.bus.request("session:get", { sessionPath: path, scope: "all" });
      sid = str(res?.session?.sessionId);
      if (!sid) lookupErrors.set(path, "session:get 返回里没有 sessionId");
    } catch (error) {
      lookupErrors.set(path, "session:get: " + (error?.message ?? String(error)));
    }
    if (!sid) {
      for (const scope of ["all", "own"]) {
        try {
          const res = await sdk.bus.request("session:list", { scope, lifecycle: "all" });
          const list = Array.isArray(res?.sessions) ? res.sessions : [];
          const hit = list.find((s) => s?.path === path || s?.sessionPath === path);
          if (hit?.sessionId) {
            sid = hit.sessionId;
            lookupErrors.delete(path);
            break;
          }
          lookupErrors.set(path, "session:list(" + scope + ") 里有 " + list.length + " 条，没匹配上这条路径");
        } catch (error) {
          lookupErrors.set(path, "session:list(" + scope + "): " + (error?.message ?? String(error)));
        }
      }
    }

    if (sid) {
      idCache.set(path, sid);
      missCache.delete(path);
    } else {
      missCache.set(path, now);
    }
    return sid;
  }

  function queuePill() {
    if (pillTimer) return;
    pillTimer = setTimeout(() => {
      pillTimer = null;
      void pushPill();
    }, SPEED_PILL_MS);
  }

  async function pushPill() {
    if (pillBusy) return;
    pillBusy = true;
    try {
      const snap = snapshot();
      const target = latest(Date.now());
      if (!target) return;
      const sid = await sessionIdFor(target.path);
      if (!sid) {
        lastPill = { at: new Date().toISOString(), sessionId: null, error: "没找到这个会话的 id" };
        pillByPath.set(target.path, lastPill);
        return;
      }
      if (target.sessionId !== sid) target.sessionId = sid;
      const tps = snap.streaming
        ? Math.round(snap.tps)
        : snap.last && snap.last.tps
          ? Math.round(snap.last.tps)
          : null;
      const text = tps !== null && tps > 0 ? String(tps) + " tok/s" : null;
      const tooltip = snap.streaming
        ? "本段输出约 " + tps + " tok/s（估算，结束后按真实用量校正）"
        : snap.last && snap.last.tps
          ? "上一段 " + Math.round(snap.last.tps) + " tok/s · " + snap.last.tokens + " tok"
          : "还没测到速度";
      if (text === null) {
        // 没数就把这一项收起来，不拿一个横杠占着位置
        await sdk.inputStatus.set({ sessionId: sid, id: "tps", visible: false });
        lastPill = { at: new Date().toISOString(), sessionId: sid, text: null, hidden: true, error: null };
        pillByPath.set(target.path, lastPill);
        return;
      }
      await sdk.inputStatus.set({ sessionId: sid, id: "tps", text, tooltip });
      lastPill = { at: new Date().toISOString(), sessionId: sid, text, error: null };
      pillByPath.set(target.path, lastPill);
    } catch (error) {
      lastPill = { at: new Date().toISOString(), sessionId: null, error: error?.message ?? String(error) };
      const t = latest(Date.now());
      if (t) pillByPath.set(t.path, lastPill);
      try {
        await sdk.logger.debug("speed meter: input status unavailable: " + (error?.message ?? String(error)));
      } catch {
        // 日志也不通就算了，别让速度计本身抛错
      }
    } finally {
      pillBusy = false;
    }
  }

  function handler(event, path) {
    try {
      if (!event || typeof event !== "object") return;
      if (event.type === "message_update") {
        const inner = event.assistantMessageEvent;
        if (!inner) return;
        if (inner.type === "text_delta" || inner.type === "thinking_delta" || inner.type === "toolcall_delta") {
          const model =
            str(event?.message?.model?.modelId) ?? str(event?.message?.modelId) ?? str(event?.message?.model);
          const m = meters.get(path);
          if (model && m) m.modelId = model;
          onDelta(path, inner);
          const after = meters.get(path);
          if (model && after) after.modelId = model;
        }
        return;
      }
      if (event.type === "llm_usage") onUsage(event.entry);
    } catch {
      // 单条事件出错不该拖垮整条订阅
    }
  }

  function attach() {
    try {
      sdk.bus.subscribe(handler, { types: ["message_update", "llm_usage"] });
    } catch {
      try {
        sdk.bus.subscribe(handler, { types: ["message_update"] });
      } catch {
        // 事件总线不可用就只靠工具和卡片，不报错
      }
    }
  }

  return { attach, snapshot };
}

export const name = "opencode-quota";

export default defineApp(async (sdk) => {
  await sdk.logger.info("opencode-quota loaded");

  const speed = createSpeedMeter(sdk);
  speed.attach();

  await sdk.routes.register((app) => {
    app.get("/quota", async (c) => c.json(await fetchAll(sdk)));
    app.get("/speed", (c) => c.json(speed.snapshot()));
  });

  await sdk.tools.register({
    name: "api_quota",
    description:
      "查询 AI 编码服务的额度用量：OpenCode Go 的 5 小时 / 本周 / 本月三档窗口，以及 Command Code 的 5 小时 / 本周窗口、剩余余额和当前套餐，各自带重置倒计时。两家服务都查，哪家没配 key 就跳过哪家。在跑长任务或大上下文之前调用它，可以判断该不该换个便宜的模型。",
    parameters: { type: "object", properties: {} },
    sessionPermission: { readOnly: true },
    execute: async () => {
      const result = await fetchAll(sdk);
      const text = result.sections.map(sectionText).join("\n");
      return { content: [{ type: "text", text }], metadata: result };
    },
  });
});
