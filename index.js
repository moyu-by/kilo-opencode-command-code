import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = "https://api.commandcode.ai/provider/v1";
// 官方模型表，带每个模型的 Text/Vision/Reasoning 能力标注（aria-label）。
const MODELS_DOCS_URL = "https://commandcode.ai/docs/reference/cli/models";
const FETCH_TIMEOUT_MS = 8000;
// 能力元数据变化很慢，缓存 7 天；同时每次启动若过期才联网刷新。
const CAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 插件目录：Windows / Linux / macOS 通用。
 * Bun 与 Node >= 20.11 提供 import.meta.dirname，旧环境回退到 fileURLToPath。
 */
const PLUGIN_DIR =
  typeof import.meta.dirname === "string" && import.meta.dirname
    ? import.meta.dirname
    : path.dirname(fileURLToPath(import.meta.url));

// 状态文件目录：优先插件目录；只读（如全局/只读安装位置）时回退到临时目录。
const STATE_DIRS = [
  PLUGIN_DIR,
  path.join(os.tmpdir(), "kilo-opencode-command-code"),
];

const MODALITY_KEYS = ["text", "image", "audio", "video", "pdf"];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// 原子写：先写临时文件再 rename，避免并发下产生半截 JSON。
const writeJson = (file, value) => {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
};

// 按目录优先级读取状态文件（读第一个存在的）。
const readState = (name) => {
  for (const dir of STATE_DIRS) {
    const data = readJson(path.join(dir, name));
    if (data) return data;
  }
  return null;
};

// 按目录优先级写入状态文件（写第一个可写的）。
const writeState = (name, value) => {
  for (const dir of STATE_DIRS) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    if (writeJson(path.join(dir, name), value)) return;
  }
};

/* ------------------------------------------------------------------ */
/* 能力推断（文档同步 → 代码强制 → 关键词兜底）                          */
/* ------------------------------------------------------------------ */

/**
 * 命中以下任一关键词（匹配模型 id 或 name）即视为支持图片输入。
 * 仅在文档同步失败且无缓存时作为最后的兜底。
 */
const VISION_HINTS = [
  "vision", "image", // 例如 deepseek/deepseek-v4-flash-vision-exp
  "claude", // Anthropic Claude
  "gemini", // Google Gemini
  "gpt-4o", "gpt-4.1", "gpt-5", "o3", "o4", "o5", // OpenAI
  "qwen", // Qwen3.x Max/Plus/Flash 等多模态
  "glm", // Z.ai GLM
  "kimi", // Moonshot Kimi
  "grok", // xAI
  "pixtral", "gemma-3", "llama-4", "muse", "mimo", "minimax",
];

/** 命中 VISION_HINTS 但仍强制按纯文本注册的模型 id 片段（最高优先级）。 */
const FORCE_TEXT_ONLY = [];

/** 未命中 VISION_HINTS 但强制开启图片输入的模型 id 片段（最高优先级）。 */
const FORCE_VISION = [];

const hasHint = (id, name, hints) => {
  const hay = `${id} ${name}`.toLowerCase();
  return hints.some((s) => hay.includes(s.toLowerCase()));
};

/** 去掉 ISO 日期类后缀，便于把 claude-haiku-4-5-20251001 匹配到 claude-haiku-4-5。 */
const normId = (id) => id.toLowerCase().replace(/[-_]?\d{6,}$/, "").trim();

/**
 * 解析文档模型表：每行一个 <code>model-id</code> 和一个
 * aria-label="Capabilities: Text input, Vision, Reasoning"。
 */
function parseCapabilities(html) {
  const map = {};
  for (const row of html.split("<tr")) {
    const idm = row.match(/<code>([^<]+)<\/code>/);
    const capm = row.match(/aria-label="Capabilities: ([^"]+)"/);
    if (!idm || !capm) continue;
    const caps = capm[1];
    map[idm[1].trim()] = {
      vision: /Vision/i.test(caps),
      reasoning: /Reasoning/i.test(caps),
    };
  }
  return map;
}

/** 拉取并解析官方能力表；失败时回退到旧缓存，再不行返回 null（走关键词兜底）。 */
async function loadCapabilities() {
  const cached = readState(".capabilities.json");
  if (
    cached?.capabilities &&
    Date.now() - (cached.fetchedAt ?? 0) < CAP_TTL_MS
  ) {
    return cached.capabilities;
  }

  try {
    const res = await fetch(process.env.CMD_MODELS_DOCS_URL || MODELS_DOCS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const capabilities = parseCapabilities(await res.text());
    if (Object.keys(capabilities).length > 0) {
      writeState(".capabilities.json", { fetchedAt: Date.now(), capabilities });
      return capabilities;
    }
    throw new Error("empty capability map");
  } catch {
    return cached?.capabilities ?? null;
  }
}

function buildCapIndex(capabilities) {
  const exact = capabilities ?? {};
  const norm = {};
  for (const [id, cap] of Object.entries(exact)) norm[normId(id)] = cap;
  return { exact, norm };
}

function lookupCapability(index, id) {
  if (index.exact[id]) return index.exact[id];
  const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  for (const key of [normId(id), normId(base)]) {
    if (index.norm[key]) return index.norm[key];
  }
  return null;
}

function resolveCapabilities(id, name, index) {
  // ① 代码内强制覆盖优先级最高（见 FORCE_TEXT_ONLY / FORCE_VISION）。
  if (hasHint(id, name, FORCE_TEXT_ONLY)) return { vision: false, reasoning: true };
  if (hasHint(id, name, FORCE_VISION)) return { vision: true, reasoning: true };

  // ② 文档同步结果（权威）。
  const doc = lookupCapability(index, id);
  if (doc) return doc;

  // ③ 关键词兜底。
  return {
    vision: hasHint(id, name, VISION_HINTS),
    reasoning: true,
  };
}

/* ------------------------------------------------------------------ */
/* 模态探测：上游字段优先，其余交给能力推断                              */
/* ------------------------------------------------------------------ */

const pickList = (value) => {
  if (!Array.isArray(value)) return null;
  const picked = [...new Set(value.filter((x) => MODALITY_KEYS.includes(x)))];
  return picked.length ? picked : null;
};

function upstreamModalities(model) {
  const input = pickList(
    model.architecture?.input_modalities ??
      model.modalities?.input ??
      model.input_modalities
  );
  if (!input) return null;
  const output = pickList(
    model.architecture?.output_modalities ??
      model.modalities?.output ??
      model.output_modalities
  );
  return { input, output: output ?? ["text"] };
}

/* ------------------------------------------------------------------ */
/* 模型列表加载                                                        */
/* ------------------------------------------------------------------ */

async function loadModelList() {
  try {
    const res = await fetch(BASE_URL + "/models", {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data?.data) && data.data.length > 0) {
      writeState(".cache.json", data);
      return data.data;
    }
    throw new Error("empty model list");
  } catch {
    const cached = readState(".cache.json");
    if (Array.isArray(cached?.data) && cached.data.length > 0) return cached.data;
    return null;
  }
}

function buildModels(items, capIndex) {
  const models = {};
  for (const m of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = m.id;
    const name = m.name || id;
    const context = m.context_length || 128000;
    const caps = resolveCapabilities(id, name, capIndex);

    // 关键字段：显式声明输入模态，否则客户端一律按纯文本处理。
    const modalities =
      upstreamModalities(m) ??
      (caps.vision
        ? { input: ["text", "image"], output: ["text"] }
        : { input: ["text"], output: ["text"] });

    if (/^claude/i.test(id)) {
      const entry = {
        name,
        reasoning: caps.reasoning,
        attachment: caps.vision,
        limit: { context, output: 64000 },
        modalities,
        provider: { npm: "@ai-sdk/anthropic" },
      };
      if (caps.reasoning) {
        entry.variants = {
          "thinking-on": { thinking: { type: "enabled", budgetTokens: 16384 } },
          "thinking-off": {},
        };
      }
      models[id] = entry;
    } else {
      const entry = {
        name,
        reasoning: caps.reasoning,
        attachment: caps.vision,
        limit: { context, output: 32000 },
        modalities,
      };
      if (caps.reasoning) {
        entry.variants = {
          low: { reasoningEffort: "low" },
          medium: { reasoningEffort: "medium" },
          high: { reasoningEffort: "high" },
        };
      }
      models[id] = entry;
    }
  }
  return models;
}

/* ------------------------------------------------------------------ */
/* 鉴权                                                               */
/* ------------------------------------------------------------------ */

/* 环境变量里可用的 API key 名称，按优先级从高到低。 */
const API_KEY_ENV_VARS = [
  "CMD_API_KEY",
  "COMMANDCODE_API_KEY",
  "COMMAND_CODE_API_KEY",
  "CMDCODE_API_KEY",
];

function envApiKey() {
  for (const name of API_KEY_ENV_VARS) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/* 支持的两个客户端；顺序仅在无法识别时作为回退优先级。 */
const CLIENTS = ["kilo", "opencode"];

/**
 * 判断当前运行在哪个客户端：Kilo 还是 OpenCode。
 * 两者的登录凭据库是分开的，必须知道该读哪一个，否则会把另一个客户端的
 * 登录状态误当成已连接。只认进程可执行文件路径（对环境变量和参数都免疫：
 * 在 Kilo 里启动 OpenCode 会同时带上 KILO=1，argv 也可能含插件路径）。
 * 用 basename 而非整串匹配，避免用户名/安装目录含 "kilo"/"opencode" 时误判；
 * 先判 kilo，避免 @kilocode 路径被 "opencode" 抢先匹配。
 */
function detectClient(execPath = process.execPath) {
  const base = path.basename(execPath || "").toLowerCase();
  if (base.includes("kilo")) return "kilo";
  if (base.includes("opencode")) return "opencode";
  return null;
}

/** 各平台可能存放客户端数据的根目录；官方真实位置 ~/.local/share 优先。 */
function authRoots(
  platform = process.platform,
  home = os.homedir(),
  env = process.env
) {
  const roots = [];
  if (env.XDG_DATA_HOME) roots.push(env.XDG_DATA_HOME);
  roots.push(path.join(home, ".local", "share"));
  if (platform === "win32") {
    if (env.LOCALAPPDATA) roots.push(env.LOCALAPPDATA);
    if (env.APPDATA) roots.push(env.APPDATA);
  } else if (platform === "darwin") {
    roots.push(path.join(home, "Library", "Application Support"));
  }
  return [...new Set(roots)];
}

/** 某客户端可能的 auth.json 位置（跨平台）。 */
function authFileCandidates(app, opts = {}) {
  return authRoots(opts.platform, opts.home, opts.env).map((root) =>
    path.join(root, app, "auth.json")
  );
}

/** 从指定客户端的凭据库里读 cmdcode 的 key；没有则返回 undefined。 */
function readStoredKey(app) {
  for (const file of authFileCandidates(app)) {
    const entry = readJson(file)?.cmdcode;
    const key = typeof entry === "string" ? entry : entry?.key;
    if (key && key.trim()) return key.trim();
  }
  return undefined;
}

/**
 * 按优先级解析已存储的 key：优先当前客户端，读不到则回退另一个客户端。
 * 纯函数，便于测试。识别失败（preferred 为 null）时按 CLIENTS 顺序尝试。
 */
function resolveStoredApiKey(preferred, readKey) {
  const order = preferred
    ? [preferred, ...CLIENTS.filter((c) => c !== preferred)]
    : CLIENTS;
  for (const app of order) {
    const key = readKey(app);
    if (key) return key;
  }
  return undefined;
}

/** 当前是否已连接 Command Code（读凭据库）。 */
function storedApiKey() {
  return resolveStoredApiKey(detectClient(), readStoredKey);
}

/** 当前是否已连接 Command Code：环境变量优先，其次凭据库。 */
function resolveApiKey() {
  return envApiKey() ?? storedApiKey();
}

async function loadAuthOptions(getAuth) {
  let fromStore;
  try {
    const auth = await getAuth();
    fromStore = typeof auth === "string" ? auth : auth?.key;
  } catch {}
  const options = { baseURL: BASE_URL };
  // 环境变量 > 客户端传入的凭据 > 直接读凭据库。
  const apiKey =
    envApiKey() ??
    (fromStore && fromStore.trim() ? fromStore.trim() : undefined) ??
    storedApiKey();
  if (apiKey) options.apiKey = apiKey;
  return options;
}

/* ------------------------------------------------------------------ */
/* 插件入口（Kilo 与 OpenCode 使用同一份 Hooks 结构）                    */
/* ------------------------------------------------------------------ */

export const CommandCode = async () => ({
  config: async (config) => {
    const provider = (config.provider ??= {});
    const cmdcode = (provider.cmdcode ??= {});
    if (!cmdcode.npm) cmdcode.npm = "@ai-sdk/openai-compatible";
    if (!cmdcode.name) cmdcode.name = "Command Code";
    const opts = (cmdcode.options ??= {});
    if (!opts.baseURL) opts.baseURL = BASE_URL;

    // 清理旧版遗留的静态 cmdcode-claude provider（若有）。
    delete provider["cmdcode-claude"];

    // 未连接（没有 API key）时不注册任何模型，/models 里就不会出现 cmdcode。
    // provider 与 auth 入口仍保留，用户可通过 /connect 或 kilo auth login 连接。
    const apiKey = resolveApiKey();
    if (!apiKey) {
      delete cmdcode.models;
      return;
    }
    if (!opts.apiKey) opts.apiKey = apiKey;

    // 用户写在配置里的 provider.cmdcode.models 优先级更高：
    // 同 id 的用户条目与自动推断结果做“条目内顶层键合并”，
    // 因此无需改插件即可手工修正某个模型的模态/参数/变体等，
    // 同时保留自动生成的 name / limit / variants。
    const userModels = cmdcode.models ?? {};
    const [items, capabilities] = await Promise.all([
      loadModelList(),
      loadCapabilities(),
    ]);
    const built = buildModels(items ?? [], buildCapIndex(capabilities));
    const merged = { ...built };
    for (const [id, entry] of Object.entries(userModels)) {
      const base = merged[id];
      merged[id] = base ? { ...base, ...entry } : entry;
    }
    if (items || Object.keys(userModels).length > 0) cmdcode.models = merged;
  },
  auth: {
    provider: "cmdcode",
    loader: loadAuthOptions,
    methods: [{ type: "api", label: "Command Code" }],
  },
});

export default CommandCode;

/* 仅供测试使用的内部纯函数，不属于对外 API。 */
export const _internal = {
  detectClient,
  authRoots,
  authFileCandidates,
  resolveStoredApiKey,
  parseCapabilities,
  normId,
};
