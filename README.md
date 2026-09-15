# kilo-opencode-command-code

[![CI](https://github.com/moyu-by/kilo-opencode-command-code/actions/workflows/ci.yml/badge.svg)](https://github.com/moyu-by/kilo-opencode-command-code/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kilo-opencode-command-code.svg)](https://www.npmjs.com/package/kilo-opencode-command-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

同时接入 [Kilo](https://kilo.ai) 与 [OpenCode](https://opencode.ai) 的 [Command Code Provider API](https://commandcode.ai/docs/provider) 插件。同一份文件，两端可用，零依赖。

## 快速开始

### 1. 安装

**方式 A：命令行安装（最简单，一条命令，自动写入配置）**

```bash
kilo plugin kilo-opencode-command-code -g       # Kilo
opencode plugin kilo-opencode-command-code -g   # OpenCode
```

**方式 B：手动加一行配置**

```jsonc
// Kilo：~/.config/kilo/kilo.jsonc
"plugin": ["kilo-opencode-command-code"]
```

```jsonc
// OpenCode：~/.config/opencode/opencode.json
"plugin": ["kilo-opencode-command-code"]
```

**方式 C：克隆 + 一键脚本（无需 npm，Kilo 和 OpenCode 一起装）**

```bash
git clone https://github.com/moyu-by/kilo-opencode-command-code.git
cd kilo-opencode-command-code
bash install.sh          # Windows: 双击 install.cmd（或 powershell -ExecutionPolicy Bypass -File .\install.ps1）
```

### 2. 登录

Kilo 与 OpenCode 凭据库独立，需各登录一次：

```bash
kilo auth login -p cmdcode      # Kilo
opencode auth login             # OpenCode，选择 Command Code
```

不想登录，就用环境变量直接给 key。

macOS / Linux / Git-Bash：

```bash
CMD_API_KEY=sk-xxxx kilo
CMD_API_KEY=sk-xxxx opencode
```

Windows PowerShell：

```powershell
$env:CMD_API_KEY = "sk-xxxx"; kilo
$env:CMD_API_KEY = "sk-xxxx"; opencode
```

Windows cmd：

```bat
set CMD_API_KEY=sk-xxxx && kilo
set CMD_API_KEY=sk-xxxx && opencode
```

重启客户端生效。

> **提示：模型按连接状态显示**
> - 未连接（没有 API key）时，`/models` 里不会出现任何 cmdcode 模型。
> - 连接后**需重启客户端一次**，模型列表才会出现（插件的 `config` 钩子只在启动时运行；这一点与原生 provider 的即时刷新不同）。
> - 启动时按此顺序找 key：环境变量 → 凭据库 `~/.local/share/kilo/auth.json` / `~/.local/share/opencode/auth.json`（Windows 上同样是 `%USERPROFILE%\.local\share\...`）。当前客户端没有凭据时会**回退使用另一个客户端的凭据**，避免“连了却不显示模型”；因此任一客户端登录过，两端都会显示模型，反之**在某一端退出登录不会让另一端断开**。

### 3. 使用

- **选模型**：打开 `/models`（或 `ctrl+x m`）→ 按 **`ctrl+a`** 打开 provider 列表 → 选 **Command Code** → 选模型
- **直接运行**：`kilo run -m cmdcode/deepseek/deepseek-v4.1-flash "你的问题"`
- **思考档位**：选模型后挑变体 `low / medium / high`；Claude 为 `thinking-on / thinking-off`
- **图片**：视觉模型（如 `cmdcode/deepseek/deepseek-v4.1-flash`）可直接粘贴/上传

## 功能

- **双端兼容**：同一份 `index.js`，Kilo 和 OpenCode 都能用
- **连接后才显示**：未配置 API key（环境变量或登录）时，`/models` 里不会出现任何 cmdcode 模型；连接后才出现，避免列出用不了的模型
- **模型自动同步**：启动时拉取 `/provider/v1/models`，断网走本地缓存，统一 `cmdcode` 入口
- **能力自动同步**：从官方模型表抓取每个模型的 `Text / Vision / Reasoning` 标注，自动声明 `modalities` 与 `reasoning`
  - 视觉模型可正常接收图片（修复 "does not support image input"）
  - 非推理模型不生成思考档位变体
  - 缓存于 `.capabilities.json`，7 天有效期；失败时用旧缓存，仍无则退回关键词兜底
- **Claude 自动路由**：Claude 走 Anthropic Messages 端点，其余走 OpenAI Chat Completions
- **更新提示**：启动后异步检查 npm 上的最新版本，有新版本时在 TUI 弹 toast（24 小时内最多查一次、同一版本只提示一次；离线或宿主不支持 toast 时静默跳过，绝不阻断启动）
- **零配置即用**：装好 + 登录一次即可；环境变量可免登录
- **可手动覆盖**：按需覆盖单个模型的模态/参数，无需改插件

## 环境变量

| 变量 | 作用 |
|---|---|
| `CMD_API_KEY` | 直接提供 API key（优先级最高） |
| `COMMANDCODE_API_KEY` / `COMMAND_CODE_API_KEY` / `CMDCODE_API_KEY` | 同上，别名 |
| `CMD_MODELS_DOCS_URL` | 覆盖能力表来源（默认官方模型表页） |
| `CMD_UPDATE_CHECK_URL` | 覆盖更新检查来源（默认 npm registry 的 `.../latest`） |

优先级：环境变量 > 凭据库中登录保存的 key。两者都没有时，客户端会照常提示登录。

## 能力覆盖（一般不需要）

能力（Vision / Reasoning）默认从官方模型表自动同步，通常无需干预。若个别模型判错或想离线锁定，在配置文件里覆盖即可：

```jsonc
{
  "provider": {
    "cmdcode": {
      "models": {
        // 强制某个模型支持图片输入
        "some/vendor/model": {
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
        // 强制某个模型为纯文本
        // ,"another/model": {
        //   "modalities": { "input": ["text"], "output": ["text"] }
        // }
      }
    }
  }
}
```

也可以在 `index.js` 顶部改 `VISION_HINTS` / `FORCE_TEXT_ONLY` / `FORCE_VISION`（仅在文档同步失败、走关键词兜底时生效）。

## 换 Key

```bash
kilo auth login -p cmdcode
opencode auth login
```

## 升级插件

插件启动后会检查 npm 上的最新版本，有新版本会弹 toast 提示（如果宿主支持 toast）。客户端本身按 lock 缓存 npm 插件，不会自动升级，手动升级方式：

- 方式 A（npm 插件）：删除 `~/.cache/opencode/packages/kilo-opencode-command-code*`（Windows：`%USERPROFILE%\.cache\opencode\packages\kilo-opencode-command-code*`）后重启客户端；或在配置里固定版本，例如 `"plugin": ["kilo-opencode-command-code@1.2.2"]`，重启后生效。
- 方式 B / C（克隆 + 脚本）：重新执行安装命令或 `install.cmd` / `install.sh`，重启客户端。

## 冒烟清单

CI 覆盖单测（Windows + Linux），真实客户端请按安装方式在 4 种组合上各过一遍：

| 步骤 | win + Kilo | win + OpenCode | lin + Kilo | lin + OpenCode |
|---|---|---|---|---|
| 安装（`install.cmd` / `install.sh` 或 npm 插件） | ☐ | ☐ | ☐ | ☐ |
| 登录（`kilo auth login -p cmdcode` / `opencode auth login`） | ☐ | ☐ | ☐ | ☐ |
| `/models` 出现 Command Code 与模型列表 | ☐ | ☐ | ☐ | ☐ |
| 纯文本模型发一条消息并收到回复 | ☐ | ☐ | ☐ | ☐ |
| 视觉模型上传一张图片并正常解析 | ☐ | ☐ | ☐ | ☐ |
| 思考档位变体（`low/medium/high` 或 `thinking-on/off`）可切换 | ☐ | ☐ | ☐ | ☐ |

## 文件结构

```
index.js            插件主文件（Kilo 与 OpenCode 共用，只导出函数）
install.sh          Linux/macOS/Git-Bash 安装脚本（同步到 OpenCode）
install.ps1         Windows PowerShell 安装脚本
install.cmd         Windows 双击包装（自动 -ExecutionPolicy Bypass 调用 install.ps1）
test/               node:test 测试
.github/workflows/  CI 与发布流程
.cache.json         模型列表缓存（运行时自动生成，已 gitignore）
.capabilities.json  能力表缓存（运行时自动生成，7 天有效期，已 gitignore）
```

## 说明

- 插件零第三方依赖、纯 ESM；`import.meta.dirname` 不可用时自动回退 `fileURLToPath`，跨平台安全。
- `index.js` 只允许导出函数、且不能拆成同目录的第二个 `.js`：宿主会遍历模块的所有导出（OpenCode 遇到非函数导出会直接抛 `TypeError` 并静默丢弃整个插件），并会把 `{plugin,plugins}/*.{ts,js}` 里的每个文件都当成插件加载。内部函数挂在 `CommandCode._internal` 上仅供测试。
- 缓存文件优先生成在插件文件同目录；该目录不可写时回退到用户级临时目录（`os.tmpdir()` 下的 `kilo-opencode-command-code-<uid>`，Windows 为 `%TEMP%`）。可写性用“实际写探测”判断（Windows 上 `fs.access(W_OK)` 不检查 ACL，会把 `C:\Program Files` 之类误判为可写），读写始终用同一个目录，避免读到旧缓存。缓存写入用“临时文件 + rename”，Windows 下目标被占用时会重试并最终退化为直接覆盖，不会静默丢缓存。
- 行为与原生接入点的唯一差异：连接后需要重启客户端一次模型才会出现（见上文提示）。凭据优先读当前客户端自己的凭据库，读不到才回退另一个客户端（见上文提示）。

## License

[MIT](./LICENSE)
