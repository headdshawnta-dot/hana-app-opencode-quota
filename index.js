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

export const name = "opencode-quota";

export default defineApp(async (sdk) => {
  await sdk.logger.info("opencode-quota loaded");

  await sdk.routes.register((app) => {
    app.get("/quota", async (c) => c.json(await fetchAll(sdk)));
  });

  await sdk.tools.register({
    name: "opencode_quota",
    description:
      "查询 AI 编码服务的额度用量：OpenCode Go 的 5 小时 / 本周 / 本月三档窗口，以及 Command Code 的 5 小时 / 本周窗口、剩余额度和当前套餐，各自带重置倒计时。在跑长任务或大上下文之前调用它，可以判断该不该换个便宜的模型。",
    parameters: { type: "object", properties: {} },
    sessionPermission: { readOnly: true },
    execute: async () => {
      const result = await fetchAll(sdk);
      const text = result.sections.map(sectionText).join("\n");
      return { content: [{ type: "text", text }], metadata: result };
    },
  });
});
