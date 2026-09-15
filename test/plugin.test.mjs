import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

// 隔离真实凭据库：插件会读 <home>/.local/share/<client>/auth.json，开发机若真的
// 登录过 Command Code，“未连接”用例会被误判成已连接。
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "cmdcode-test-home-"));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
delete process.env.XDG_DATA_HOME;
after(() => {
  try {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  } catch {}
});

const MODELS = {
  object: "list",
  data: [
    {
      id: "deepseek/deepseek-v4.1-flash",
      object: "model",
      name: "DeepSeek V4.1 Flash",
      context_length: 1000000,
    },
    {
      id: "deepseek/deepseek-v4-flash",
      object: "model",
      name: "DeepSeek V4 Flash (latest)",
      context_length: 1000000,
    },
    {
      id: "claude-opus-5",
      object: "model",
      name: "Claude Opus 5",
      context_length: 200000,
    },
  ],
};

const DOCS_HTML = `
<tr>
  <td><code>deepseek/deepseek-v4.1-flash</code></td>
  <td><span aria-label="Capabilities: Text input, Vision, Reasoning"></span></td>
</tr>
<tr>
  <td><code>deepseek/deepseek-v4-flash</code></td>
  <td><span aria-label="Capabilities: Text input, Reasoning"></span></td>
</tr>
<tr>
  <td><code>claude-opus-5</code></td>
  <td><span aria-label="Capabilities: Text input, Vision, Reasoning"></span></td>
</tr>
`;

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes("api.commandcode.ai")) {
    return new Response(JSON.stringify(MODELS), { status: 200 });
  }
  return new Response(DOCS_HTML, { status: 200 });
};

// 插件只在“已连接”时注册模型；测试里用环境变量模拟已连接。
process.env.CMD_API_KEY = "test-env-key";

const { CommandCode } = await import("../index.js");
const {
  authFileCandidates,
  authRoots,
  detectClient,
  firstWritableDir,
  resolveStoredApiKey,
  stateDirCandidates,
} = CommandCode._internal;

// 去掉可能存在的真实缓存（插件目录与临时回退目录），保证测试走 stub，结果确定。
for (const dir of stateDirCandidates(pluginDir)) {
  for (const file of [".cache.json", ".capabilities.json"]) {
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {}
  }
}

const plugin = await CommandCode();
const config = {};
await plugin.config(config);
const models = config.provider.cmdcode.models;

test("registers the cmdcode provider with the Command Code base URL", () => {
  assert.equal(
    config.provider.cmdcode.options.baseURL,
    "https://api.commandcode.ai/provider/v1"
  );
  assert.equal(config.provider.cmdcode.name, "Command Code");
});

test("auto-syncs every model from the provider API", () => {
  assert.deepEqual(
    Object.keys(models).sort(),
    [
      "claude-opus-5",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4.1-flash",
    ]
  );
});

test("derives vision modality from the official capability table", () => {
  assert.deepEqual(
    models["deepseek/deepseek-v4.1-flash"].modalities.input,
    ["text", "image"]
  );
  assert.deepEqual(models["deepseek/deepseek-v4-flash"].modalities.input, [
    "text",
  ]);
  assert.equal(models["deepseek/deepseek-v4.1-flash"].attachment, true);
  assert.equal(models["deepseek/deepseek-v4-flash"].attachment, false);
});

test("routes Claude models to the Anthropic endpoint with thinking variants", () => {
  assert.equal(models["claude-opus-5"].provider.npm, "@ai-sdk/anthropic");
  assert.ok(models["claude-opus-5"].variants["thinking-on"]);
});

test("adds reasoning effort variants for non-Claude models", () => {
  assert.ok(models["deepseek/deepseek-v4.1-flash"].variants.low);
  assert.ok(models["deepseek/deepseek-v4.1-flash"].variants.high);
});

test("reads the API key from CMD_API_KEY when no stored auth exists", async () => {
  const previous = process.env.CMD_API_KEY;
  process.env.CMD_API_KEY = "test-env-key";
  try {
    const options = await plugin.auth.loader(async () => undefined);
    assert.equal(options.apiKey, "test-env-key");
    assert.equal(options.baseURL, "https://api.commandcode.ai/provider/v1");
  } finally {
    if (previous === undefined) delete process.env.CMD_API_KEY;
    else process.env.CMD_API_KEY = previous;
  }
});

test("does not register models until the user has connected", async () => {
  const names = [
    "CMD_API_KEY",
    "COMMANDCODE_API_KEY",
    "COMMAND_CODE_API_KEY",
    "CMDCODE_API_KEY",
  ];
  const previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  try {
    const config = {};
    await plugin.config(config);
    assert.equal(config.provider.cmdcode.models, undefined);
    assert.equal(
      config.provider.cmdcode.options.baseURL,
      "https://api.commandcode.ai/provider/v1"
    );
  } finally {
    for (const n of names) {
      if (previous[n] === undefined) delete process.env[n];
      else process.env[n] = previous[n];
    }
  }
});

test("detectClient identifies the host by executable basename (Windows + POSIX)", () => {
  assert.equal(
    detectClient(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe"
    ),
    "opencode"
  );
  assert.equal(
    detectClient(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@kilocode\\cli\\node_modules\\@kilocode\\cli-windows-x64\\bin\\kilo.exe"
    ),
    "kilo"
  );
  assert.equal(detectClient("/usr/local/bin/opencode"), "opencode");
  assert.equal(detectClient("/opt/kilo/bin/kilo"), "kilo");
  assert.equal(detectClient("C:\\Program Files\\nodejs\\node.exe"), null);
  assert.equal(detectClient("C:\\Program Files\\nodejs\\bun.exe"), null);
});

test("detectClient ignores client names appearing in parent directories", () => {
  // 用户名/目录名含 kilo，但可执行文件是 opencode → 仍判 opencode
  assert.equal(
    detectClient("C:\\Users\\kilo\\node_modules\\opencode-ai\\bin\\opencode.exe"),
    "opencode"
  );
  // 目录名含 opencode，但宿主是 node → 不误判
  assert.equal(detectClient("C:\\Users\\opencode\\node.exe"), null);
});

test("authRoots prefers XDG_DATA_HOME then ~/.local/share on Windows", () => {
  const home = "C:\\Users\\me";
  const env = {
    XDG_DATA_HOME: "D:\\xdg",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  };
  const roots = authRoots("win32", home, env);
  assert.equal(roots[0], "D:\\xdg");
  assert.equal(roots[1], path.join(home, ".local", "share"));
  // 真实位置必须排在 %APPDATA% / %LOCALAPPDATA% 之前
  assert.ok(
    roots.indexOf(path.join(home, ".local", "share")) <
      roots.indexOf(env.APPDATA)
  );

  const files = authFileCandidates("opencode", { platform: "win32", home, env });
  assert.equal(files[0], path.join("D:\\xdg", "opencode", "auth.json"));
  assert.equal(files[1], path.join(home, ".local", "share", "opencode", "auth.json"));
});

test("resolveStoredApiKey falls back to the other client's store", () => {
  // 识别为 opencode，但只有 kilo 存了 key → 回退读到 kilo 的 key
  assert.equal(
    resolveStoredApiKey("opencode", (app) => (app === "kilo" ? "k" : undefined)),
    "k"
  );

  // 识别失败时按 CLIENTS 顺序（kilo 优先）尝试，且不早退
  const seen = [];
  const key = resolveStoredApiKey(null, (app) => {
    seen.push(app);
    return app === "opencode" ? "o" : undefined;
  });
  assert.equal(key, "o");
  assert.deepEqual(seen, ["kilo", "opencode"]);

  // 两端都没有
  assert.equal(resolveStoredApiKey("kilo", () => undefined), undefined);
});

test("plugin entry only exports factories (host loaders scan every export)", async () => {
  // 复刻 OpenCode 的 getLegacyPlugins()：它遍历模块的全部导出，遇到不是函数、
  // 也没有 .server 函数的导出就 `throw new TypeError("Plugin export is not a function")`，
  // 整个插件会被静默丢弃（Kilo 只是跳过）。因此 index.js 不允许导出非函数。
  const mod = await import("../index.js");
  const seen = new Set();
  for (const [name, entry] of Object.entries(mod)) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    const plugin = typeof entry === "function" ? entry : entry?.server;
    assert.equal(
      typeof plugin,
      "function",
      `export "${name}" is not a plugin factory`
    );
  }
  // 测试钩子只挂在函数对象上，不能变成模块导出
  assert.equal(mod._internal, undefined);
  assert.equal(typeof CommandCode._internal, "object");
});

test("stateDirCandidates keeps read and write on the same directory", () => {
  const dirs = stateDirCandidates("/plugin/dir", 1000, "/tmp");
  assert.equal(dirs[0], "/plugin/dir");
  assert.equal(dirs[1], path.join("/tmp", "kilo-opencode-command-code-1000"));
  // 只读插件目录时回退的是第二个候选，且两者不会互相覆盖
  assert.notEqual(dirs[0], dirs[1]);
});

test("firstWritableDir falls back to the temp dir when the plugin dir is read-only", () => {
  // root 会无视权限位；Windows 没有这套权限模型
  if (process.platform === "win32" || process.getuid?.() === 0) return;

  const readOnly = fs.mkdtempSync(path.join(os.tmpdir(), "cmdcode-ro-"));
  const fallback = fs.mkdtempSync(path.join(os.tmpdir(), "cmdcode-rw-"));
  fs.chmodSync(readOnly, 0o500);
  try {
    assert.equal(firstWritableDir([readOnly, fallback]), fallback);
    // 可写时仍然优先插件目录
    fs.chmodSync(readOnly, 0o700);
    assert.equal(firstWritableDir([readOnly, fallback]), readOnly);
  } finally {
    try {
      fs.chmodSync(readOnly, 0o700);
    } catch {}
    fs.rmSync(readOnly, { recursive: true, force: true });
    fs.rmSync(fallback, { recursive: true, force: true });
  }
});
