# agentboat-hands

一个 MCP 工具服务：让在另一台机器上运行的 AI agent，操作这台机器上的文件、命令和桌面。

- agent 和它的订阅登录留在主机上。项目所在的机器只运行这个服务，不登录任何模型账号，也不保存凭据。
- 不绑定某一家 agent。支持 MCP 的 agent 都能接，已实测 Claude Code 和 Codex。
- 没有 npm 依赖，装了 Node 就能跑。

```
主机（agent、订阅）──SSH──▶ hands.mjs（文件、命令）
                              └─本机回环 + 令牌─▶ 登录会话里的桌面代理（截图、键鼠）
```

下文把这个服务所在的机器叫「附属机器」，并用 `D:/tools/agentboat-hands` 表示本项目在附属机器上的位置，请换成你的实际路径。

## 要求

- Node.js 22 以上。
- 桌面工具只支持 Windows 10 1703 以上和 Windows 11，用系统自带的 Windows PowerShell 5.1 和 .NET Framework。在 macOS 和 Linux 上，文件和命令工具可用，桌面工具会返回「暂不支持」。
- 可选：读 PDF 文字需要 `pdftotext` 或 Python 的 `pypdf`；工作树并行需要 Git。

## 启动

```sh
node hands.mjs <根目录> [更多根目录...]
```

它通过标准输入输出说 MCP 协议，通常由 agent 拉起，不需要手动运行。经 SSH 接入时，agent 一侧的 MCP 配置大致是：

```json
{
  "mcpServers": {
    "hands": {
      "command": "ssh",
      "args": ["user@windows-host", "node D:/tools/agentboat-hands/hands.mjs D:/projects/demo"]
    }
  }
}
```

实际使用时建议用下面的[配置生成器](#接入-claude-codecodexopencode)，它会处理引号和编码，并关掉 agent 自带的本地工具。

## 工具

| 工具 | 用途 |
| --- | --- |
| `read_file` | 读文件。文本自动识别 UTF-8、UTF-16、GBK，长文件分段返回；PNG、JPEG、GIF、WebP 按图片返回；PDF 默认按文档返回，`pdf_format=text` 时返回文字。 |
| `write_file` | 新建文件，或整体替换一个已经读过的文件。保留原文件的编码和换行。 |
| `edit_file` | 精确替换文件里的一段文字。必须唯一匹配，或设 `replace_all`。 |
| `list_directory` | 列出一个目录。 |
| `find_files` | 按通配符找文件，新的在前。默认跳过 `.git` 和 `node_modules`。 |
| `search_content` | 用正则表达式逐行搜索内容，GBK 文件也能搜。 |
| `run_command` | 执行命令，返回退出码、输出和错误。Windows 上默认用 PowerShell，可选 cmd 或 bash。`background` 用于开发服务器这类长时间运行的程序。 |
| `process_output` | 查看后台进程是否还在运行，以及最近的输出。 |
| `stop_process` | 停止后台进程和它启动的所有进程。 |
| `desktop_displays` | 显示器的索引、物理像素范围、DPI。 |
| `desktop_windows` | 可见窗口的句柄、标题、进程、位置大小、是否在前台。 |
| `desktop_focus` | 把指定窗口还原并切到前台。 |
| `desktop_screenshot` | 截全屏、某个显示器、某个窗口或某块区域，返回图片和缩放比例。 |
| `desktop_mouse` | 在指定窗口内移动、点击、双击、拖拽、滚动。 |
| `desktop_type` | 输入文字，含中文，不动剪贴板。 |
| `desktop_key` | 按下并释放一组组合键，例如 `["CTRL","SHIFT","S"]`。 |

## 安全边界

- **文件工具只能碰根目录以内。** 路径会先解析链接再检查，绕不出去。
- **命令不受这个限制，它不是沙箱。** 能连上这个服务的人，可以用运行它的用户身份执行任何命令。所以只应通过 SSH 密钥暴露它，不要把它挂到网络端口上。
- **改文件前必须先读过。** 文件在读过之后被别人改了，也要重新读才能改。
- **连接断开时，它启动的进程会一起结束。**
- **GBK 文件只读。** 要改先转成 UTF-8。

## 桌面控制

经 SSH 启动的进程不在用户的桌面会话里，截不了屏也发不了键鼠输入。所以桌面工具由一个常驻在登录会话里的代理执行，SSH 那头的 `hands.mjs` 只做转接。

在附属机器上，用要被控制的那个 Windows 用户运行一次：

```powershell
powershell.exe -NoProfile -File D:\tools\agentboat-hands\start-desktop.ps1 -RegisterLogonTask
```

它注册一个名为 `AgentBoat-Hands-<当前用户SID>` 的登录任务并立即启动。任务以普通权限运行，不保存密码，只在该用户已登录时运行。也可以在已登录的终端里前台运行 `node desktop-agent.mjs`，按 Ctrl+C 停止。

代理的边界：

- 只监听 `127.0.0.1` 的随机端口，每次启动生成新的 256 位令牌。
- 端口和令牌写在 `%LOCALAPPDATA%\AgentBoat\hands-desktop\endpoint.json`，目录只允许当前用户访问。
- SSH 必须用同一个 Windows 用户登录。管理员和 SYSTEM 不在这个隔离范围内。
- 机器未登录、锁屏、出现 UAC 提示时，桌面工具返回明确的错误，不会去碰安全桌面。

使用上的约定：

- 输入类工具必须指定 `window_id`，不会自己切换窗口。先列窗口，再切到前台，再输入。
- `desktop_focus` 在后台调用时会临时附加前台和目标窗口的输入线程，切换后立即分离，再核对前台句柄；不需要管理员权限，系统仍拒绝时返回错误。
- 输入前会检查前台窗口；鼠标还会检查目标点属于该窗口且没有被遮挡。中途失去焦点立即中止。
- 坐标一律是物理屏幕像素，左侧或上方的显示器坐标可以为负。截图默认把最长边缩到 1600，并返回换算关系：

```text
screenX = bounds.x + imageX / scaleX
screenY = bounds.y + imageY / scaleY
```

- 窗口截图用 PrintWindow，失败时报错，不会退回成全屏截图。部分用 GPU 渲染或受保护的窗口可能截出空白。

更新源码后要先停止登录任务再启动，才会加载新版本。卸载时用 `Stop-ScheduledTask` 和 `Unregister-ScheduledTask` 指定上面的任务名。

## 接入 Claude Code、Codex、OpenCode

在主机上生成一份独立的配置目录，然后启动：

```sh
node agents/generate.mjs --agent claude --ssh user@windows-host --root 'D:/projects/demo' --hands 'D:/tools/agentboat-hands/hands.mjs' --out ./boat-claude --model haiku
node agents/run.mjs ./boat-claude '读取项目并开始任务'
```

- `--agent` 可选 `claude`、`codex`、`opencode`。
- `--hands` 是 `hands.mjs` 在附属机器上的路径，经 SSH 时必须给。
- `--out` 必须是还不存在的目录。生成器不会改你的全局配置。
- SSH 使用非交互模式和严格的主机密钥校验，请先配好密钥和 `known_hosts`。

各家的做法和限制：

- **Claude Code**：内置工具只保留 `Read`，并且只预先批准读它自己缓存 PDF 附件的目录。其余操作都走这个服务。
- **Codex**：忽略用户配置，主机一侧用只读沙箱，只注入这个服务并预先批准它的工具。**当前版本关不掉 Codex 自带的本地执行工具**，这份配置靠提示词约束，不是强隔离。需要硬隔离时，请在主机上用单独的系统用户、容器或虚拟机运行它。
- **OpenCode**：已在 Windows 用官方独立 CLI **2.3.0** 验证。配置使用 V2 的 `mcp.servers.hands`，连接后登记全部 16 个 hands 工具；专用 `hands` agent 默认拒绝其他工具，实际权限检查中内置 read/edit/glob/grep/shell 均被拒绝，hands 工具被允许。启动使用独立的 `run --standalone`，传入 `--model` 时同时固定 CLI 模型，避免默认模型不可用时回退到其他模型。Windows 按[官方说明](https://opencode.ai/docs/)下载独立 CLI，放进当前用户 `PATH` 里的目录即可，无需管理员权限。

  本机测试可运行 `node agents/generate.mjs --agent opencode --local --root '<项目绝对路径>' --out ./boat-opencode`，然后 `node agents/run.mjs ./boat-opencode '<任务>'`。免登录模型目录可列出，但此次请求 `opencode/nemotron-3.5-super-vl-free` 被服务端以免费额度耗尽（429）拒绝，因此**尚未完成真实模型端到端验证**。继续使用前，请用户自己通过 `opencode auth login`（或交互界面 `/connect`）连接有额度的模型来源，再用 `opencode models` 确认模型 ID，并通过生成器 `--model provider/model` 明确选择；不需要把凭据交给 agent。测试用独立的 XDG 配置/数据/缓存目录，不修改用户的 OpenCode 全局配置或 Claude/Codex 配置。设置 `HANDS_TEST_OPENCODE_BIN` 为 OpenCode 可执行文件的路径后，`npm test` 会多跑一项接入测试（不调用模型）。

## PDF

- `read_file({path:"doc.pdf"})` 把 PDF 作为文档返回，适合能直接打开文档的 agent。
- `read_file({path:"doc.pdf", pdf_format:"text"})` 在附属机器上提取文字后返回，可以用 `offset` 和 `limit` 分段。

提取文字优先用 `PATH` 里的 `pdftotext`，没有就用 Python 的 `pypdf`。可以用环境变量 `HANDS_PDFTOTEXT` 或 `HANDS_PDF_PYTHON` 指定程序位置，生成器的 `--pdf-python` 会把后者写进启动命令。两者都没有时会报出安装说明，不会自动安装。扫描件没有文字层，会提示需要 OCR，本项目没有做 OCR。

## 多个 agent 并行

每个 agent 用自己的 Git 工作树，互不影响。下面的命令在附属机器上执行：

```sh
node D:/tools/agentboat-hands/worktree.mjs create --repo D:/projects/demo --path D:/projects/demo-agent-a --branch agentboat/agent-a
node D:/tools/agentboat-hands/worktree.mjs list --repo D:/projects/demo
node D:/tools/agentboat-hands/worktree.mjs remove --repo D:/projects/demo --path D:/projects/demo-agent-a
```

然后为每个 agent 用它自己的工作树目录作为 `--root` 生成配置。

- 创建时不会复用已有的目录或分支。
- 清理时只删除登记过的工作树，有未提交改动时拒绝，不会删除分支。
- 工作树隔离的是文件，不是命令。它不能当作沙箱用。

## 测试

```sh
npm test
```

默认的测试不会把窗口切到前台，也不会发送键鼠输入，只会打开一个自己的小窗口截图后关闭。两类测试需要显式开启：

- `HANDS_TEST_INPUT=1`：先用 `desktop_focus` 聚焦测试自己打开的窗口，再做一次点击和一次中文输入，核对点击计数和完整文字，保存前后窗口截图。每步仍检查精确窗口和前台状态，失焦立即中止。期间请不要动键盘鼠标。
- `HANDS_TEST_LOGON=1`：注册一个临时的登录任务，验证代理能在登录会话里启动，结束后移除。

2026-11-13 在一台 Windows 11 单屏机器上实测通过：后台代理把测试窗口切到前台，点击一次、输入 `AgentBoat 中文🛶`，点击计数从 0 变为 1，窗口文字与预期一致。测试的前后截图和记录写在 `evidence/` 下，不进 git。

`agents/verify-live.mjs` 会用真实的 Claude Code 或 Codex 跑一遍端到端检查，会消耗订阅额度。

## 还没验证的

- 跨两台机器经 SSH 的整条链路。目前的端到端测试都在同一台机器上。
- 右键、双击、拖拽、滚轮及组合键的实机送达。基础点击和含中文文字输入已验证。
- 多显示器和不同缩放比例混用。
- 配置生成器在 macOS 上的运行。
- OpenCode 的真实模型端到端操作：CLI、MCP 连接及本地工具权限已验证，模型请求受免费额度限制；见上文 OpenCode 段落。
- macOS 和 Linux 上的桌面控制还没有实现。
