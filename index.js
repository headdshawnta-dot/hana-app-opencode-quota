import { defineApp } from "./sdk/app-contract/server-client.js";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const WINDOW_LABELS = {
  rolling: "5 小时",
  weekly: "本周",
  monthly: "本月",
};

const WINDOW_NOTES = {
  rolling: "滚动 5 小时窗口，用满会直接卡住",
  weekly: "本周窗口",
  monthly: "月额度，所有窗口的基准",
};

/** 把 HTTP 状态翻译成人能看懂的原因，别用一句“失败”糊过去。 */
function describeHttpFailure(status) {
  if (status === 401) {
    return {
      code: "KEY_INVALID",
      message: "API key 无效或已过期，去 opencode 后台重新建一把填进设置。",
    };
  }
  if (status === 403) {
    return {
      code: "NO_SUBSCRIPTION",
      message: "这把 key 没有 Go 计划的权限，可能是订阅过期，或者 key 属于别的工作区。",
    };
  }
  if (status === 404) {
    return {
      code: "ENDPOINT_MOVED",
      message: "额度接口不见了。opencode 改了路径或下线了它，这个应用需要更新。",
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      message: "请求太频繁被挡了，等一会儿再试。",
    };
  }
  return {
    code: "HTTP_" + status,
    message: "接口报了 " + status + "，不是预期内的错误。",
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeWindows(usage, nowMs, warn, danger) {
  const windows = [];
  for (const key of ["rolling", "weekly", "monthly"]) {
    const raw = usage?.[key];
    const percent = numberOrNull(raw?.percent);
    if (percent === null) continue;
    const resetsAt = typeof raw?.resetsAt === "string" ? raw.resetsAt : null;
    const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
    const secondsLeft = Number.isFinite(resetMs)
      ? Math.max(0, Math.round((resetMs - nowMs) / 1000))
      : null;
    windows.push({
      key,
      label: WINDOW_LABELS[key],
      note: WINDOW_NOTES[key],
      percent: Math.min(100, Math.max(0, Math.round(percent))),
      status: typeof raw?.status === "string" ? raw.status : null,
      resetsAt,
      secondsLeft,
      level:
        percent >= danger ? "danger" : percent >= warn ? "warn" : "ok",
    });
  }
  return windows;
}

async function readLimits(sdk) {
  const warn = numberOrNull(await sdk.config.get("warnPercent")) ?? 70;
  const danger = numberOrNull(await sdk.config.get("dangerPercent")) ?? 90;
  return { warn, danger };
}

async function fetchQuota(sdk) {
  const nowMs = Date.now();
  const stored = await sdk.config.get("apiKey");
  const apiKey = typeof stored === "string" ? stored.trim() : "";

  if (apiKey === "") {
    return {
      ok: false,
      code: "NO_KEY",
      message: "还没填 API key。在应用设置里粘贴一把只能读额度的 key 就能用。",
      fetchedAt: new Date(nowMs).toISOString(),
    };
  }

  // 设置表单什么都吞得下。中文、全角符号、整段笔记都能存进来，
  // 而一旦混进请求头，浏览器会在联网前就报一个看不懂的字节错误。
  // 所以在发请求之前先把格式挡住，用能看懂的话说清楚。
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    const bad = [...apiKey].find((ch) => ch.codePointAt(0) > 0x7e);
    const where = bad
      ? "第 " + (apiKey.indexOf(bad) + 1) + " 个字符是「" + bad + "」"
      : "里面有空格或不可见字符";
    return {
      ok: false,
      code: "KEY_MALFORMED",
      message:
        "这一栏里存的不是一把 key（" + where + "，码位 " +
        (bad ? bad.codePointAt(0) : "?") +
        "）。大概是从别处粘贴时连带了中文或标点。把整栏清空，重新粘贴纯英文的那一串。",
      fetchedAt: new Date(nowMs).toISOString(),
    };
  }

  if (/^\*+$/.test(apiKey)) {
    return {
      ok: false,
      code: "KEY_MASKED",
      message: "读到的是设置页的掩码（一串星号），说明真正的值没存进去。重新粘贴一次再保存。",
      fetchedAt: new Date(nowMs).toISOString(),
    };
  }

  let response;
  try {
    response = await sdk.network.fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + apiKey,
        Accept: "application/json",
      },
      timeoutMs: 15000,
      maxResponseBytes: 65536,
    });
  } catch (error) {
    return {
      ok: false,
      code: "NETWORK",
      message: "请求没能发出去：" + (error?.message ?? String(error)),
      fetchedAt: new Date(nowMs).toISOString(),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      ...describeHttpFailure(response.status),
      fetchedAt: new Date(nowMs).toISOString(),
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      ok: false,
      code: "BAD_PAYLOAD",
      message: "接口返回的不是 JSON，可能已经改版了。",
      fetchedAt: new Date(nowMs).toISOString(),
    };
  }

  const { warn, danger } = await readLimits(sdk);
  const windows = normalizeWindows(payload?.usage, nowMs, warn, danger);

  if (windows.length === 0) {
    return {
      ok: false,
      code: "EMPTY_PAYLOAD",
      message: "接口通了，但里面没有用量数据，字段可能被改名了。",
      fetchedAt: new Date(nowMs).toISOString(),
    };
  }

  const tightest = windows.reduce((a, b) => (b.percent > a.percent ? b : a));

  return {
    ok: true,
    windows,
    tightest: { key: tightest.key, label: tightest.label, percent: tightest.percent },
    fetchedAt: new Date(nowMs).toISOString(),
  };
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

function toText(result) {
  if (!result.ok) {
    return "查不到额度：" + result.message + "（" + result.code + "）";
  }
  const lines = result.windows.map((w) => {
    const left = w.secondsLeft === null ? "" : "，" + formatDuration(w.secondsLeft) + "后重置";
    return w.label + "已用 " + w.percent + "%" + left;
  });
  const tight = result.tightest;
  const advice =
    tight.percent >= 90
      ? "最紧的是" + tight.label + "窗口，已经压到 " + tight.percent + "%，再开大任务容易撞断。"
      : tight.percent >= 70
        ? "最紧的是" + tight.label + "窗口，" + tight.percent + "%，悠着点。"
        : "三个窗口都宽松，最紧的" + tight.label + "才 " + tight.percent + "%。";
  return lines.join("；") + "。" + advice;
}

export const name = "opencode-quota";

export default defineApp(async (sdk) => {
  await sdk.logger.info("opencode-quota loaded");

  await sdk.routes.register((app) => {
    app.get("/quota", async (c) => {
      const result = await fetchQuota(sdk);
      return c.json(result);
    });
  });

  await sdk.tools.register({
    name: "opencode_quota",
    description:
      "查询 OpenCode Go 计划的额度用量：5 小时滚动窗口、本周、本月三个窗口各自的已用百分比与重置倒计时。在跑长任务或大上下文之前调用它，可以判断该不该换个便宜的模型。",
    parameters: { type: "object", properties: {} },
    sessionPermission: { readOnly: true },
    execute: async () => {
      const result = await fetchQuota(sdk);
      return {
        content: [{ type: "text", text: toText(result) }],
        metadata: result,
      };
    },
  });
});
