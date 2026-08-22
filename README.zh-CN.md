# dsh-tool-github

> [English](README.md) · [中文](README.zh-CN.md)

<p align="center">
  <img src="https://img.shields.io/github/license/tkwkeven/dsh-tool-github" alt="License">
  <img src="https://img.shields.io/github/stars/tkwkeven/dsh-tool-github" alt="GitHub stars">
  <img src="https://img.shields.io/github/forks/tkwkeven/dsh-tool-github" alt="GitHub forks">
  <img src="https://img.shields.io/github/last-commit/tkwkeven/dsh-tool-github" alt="Last commit">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f46e5" alt="DSH plugin">
</p>

面向 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）的 GitHub REST API 工具。注册面向模型（model-facing）的 `github_*` 工具，使智能体（agent）可以绑定 GitHub 账号、查询仓库、搜索代码/议题（issue）、读取文件内容、创建议题 / 拉取请求（pull request）/ 评论，以及将仓库克隆为可选工作区。同时为 Web GUI 提供一个**浏览器端 GitHub 面板**（侧边栏图标 → 账号状态、工作区列表、绑定 / 添加工作区操作），由 `/github-*` 命令驱动。

## Web GUI 面板

安装并**完全重启 GUI**（`dsh web`——客户端插件发现只在进程启动时运行，并会缓存"非客户端插件包"的判断结果，因此运行中的 GUI 不会识别新添加的 `dsh.client` 声明）之后，侧边栏轨道（sidebar rail）中会出现一个 GitHub 图标（位于设置按钮旁边）。点击它即可打开 GitHub 面板：

- **状态（Status）** — 已绑定的账号（@login、token 来源）和已注册的 GitHub 工作区（来自 `/github-status`）
- **我的仓库（My repos）** — **以可点击列表行的形式列出已绑定账号的仓库；点击某个仓库即可克隆并将其注册为工作区**（来自 `/github-my-repos` + `/github-workspace-add`）
- **绑定账号…（Bind account…）** — 粘贴个人访问令牌（personal access token）（运行 `/github-bind <token>`）
- **添加工作区…（Add workspace…）** — 输入 `owner/repo`（或 `owner repo [branch]`）以克隆并注册一个工作区（运行 `/github-workspace-add`）
- **刷新（Refresh）** — 重新读取状态

面板仅通过 `/github-*` 命令（`ctx.remote.commands.execute`）与宿主机（host）通信，因此它从不持有 token，也从不直接接触 GitHub API。同样的命令也可以直接在 composer（消息输入框）中键入：

```
/github-status              显示账号 + 工作区状态
/github-bind ghp_xxx        绑定账号
/github-unbind              移除已存储的 token
/github-workspace-add owner repo [branch]
/github-workspace-list      列出已克隆的 GitHub 工作区
```

## 工具

### 账号绑定

| 工具 | 描述 |
|---|---|
| `github_bind` | 针对 API 校验个人访问令牌，并将其持久化到凭据存储（credential store）。绑定后，所有 `github_*` 工具都会自动以该账号身份进行认证。 |
| `github_whoami` | 显示已绑定的账号、token 来源（凭据存储 / 插件配置 / 环境变量）以及公开资料（public profile）。 |
| `github_unbind` | 移除已存储的 token 并断开账号连接。 |

### GitHub API

| 工具 | 描述 |
|---|---|
| `github_repo` | 仓库元数据（star 数、fork 数、语言、许可证、主题（topics）、活跃度） |
| `github_search` | 搜索仓库、代码或议题 |
| `github_my_repos` | **列出已绑定账号的仓库**（按 token 权限范围包含公开 + 私有）——选择一个进行工作或添加为工作区 |
| `github_issues` | 列出仓库议题（支持按状态 / 标签过滤） |
| `github_create_issue` | 创建议题（需要已绑定的账号 / token） |
| `github_prs` | 列出拉取请求（支持按状态过滤） |
| `github_create_pr` | 创建拉取请求（需要已绑定的账号 / token） |
| `github_content` | 在任意 ref（分支 / 标签 / 提交）下读取文件或列出目录 |
| `github_comment` | 在议题或 PR 上评论（需要已绑定的账号 / token） |

### 工作区

| 工具 | 描述 |
|---|---|
| `github_workspace_add` | 将仓库克隆到本地工作区根目录（`~/.dsh/github-workspaces`），并注册到 harness 的工作区注册表（workspace registry）——之后它会出现在**工作区选择器**（侧边栏 / 新建会话主界面）中，可以被选为工作目录。尽可能使用 `git clone`；当 git TLS 不可用时，回退为从 codeload 下载 tarball 压缩包。 |
| `github_workspace_list` | 列出由 `github_workspace_add` 克隆的仓库，包括本地路径和注册状态。 |

## 安装

```bash
# 在此检出（checkout）目录下执行
dsh plugin --profile web add .
```

或通过本地路径：

```bash
dsh plugin --profile web add D:\keep_try\dsh-tool-github
```

安装或更新后请重启 Web GUI（`dsh web`），以便加载新的 bundle（打包产物）。

## 使用示例

```
"帮我绑定 GitHub 账号"                       → github_bind (输入 token)
"当前登录的 GitHub 账号是谁"                 → github_whoami
"把 deepseek-ai/DeepSeek-Harness 加为工作区" → github_workspace_add
"有哪些 GitHub 仓库可以作为工作区"           → github_workspace_list
"deepseek-harness 有多少 star"               → github_repo
"搜 python 的 PDF 解析库 stars:>3000"        → github_search
```

## 配置

插件接受一个 `Config` 配置，包含：

- `token` — GitHub 个人访问令牌（默认：`""`）。优先使用 `github_bind`（凭据存储）或 `GITHUB_TOKEN` 环境变量；解析顺序为**凭据存储 → 插件配置 → 环境变量**。
- `baseUrl` — API 基础 URL（默认 `https://api.github.com`；可设置为你的 GitHub Enterprise URL，例如 `https://github.example.com/api/v3`）。
- `timeoutMs` — 每次调用的超时时间（默认 `30000`）。
- `maxResults` — 列表 / 搜索结果的条数上限（默认 `10`）。
- `workspaceRoot` — `github_workspace_add` 克隆仓库的位置（默认 `~/.dsh/github-workspaces`）。

示例 profile 补丁（`~/.dsh/cordis.patch.yml` 或 `profiles/<name>/cordis.patch.yml`）：

```yaml
- id: tool-github
  config:
    maxResults: 20
    workspaceRoot: D:\github-workspaces
```

## 账号绑定的工作原理

`github_bind` 会通过 `GET /user` 校验 token，然后经 DSH 的凭据接口（`ctx.credentials`）将其存储到 `GITHUB_TOKEN` 引用下——这与 Models 页面写入的是同一个存储，持久化于 `$DSH_HOME/.credentials.yaml`。其他所有工具都在每次操作时解析 token，因此凭据变更无需重启即可在下一次调用时生效。`github_unbind` 只移除凭据存储中的绑定；环境变量和插件配置中的 token 属于只读来源。

## 工作区集成的工作原理

`github_workspace_add` 会将 `<owner>/<repo>` 克隆到 `<workspaceRoot>/<owner>/<repo>`，然后调用 `ctx.workspaceRegistry.create(path, title)`——这与工作区选择器渲染用的是同一个注册表。该仓库会立即成为可选工作区：在那里打开的会话以该仓库作为工作目录，智能体的文件工具都在克隆目录内操作。

## 开发

```bash
npm install          # 安装开发/测试依赖
npm run check        # 对两个 bundle 做语法检查
npm test             # 完整测试套件（host + client + schema + contract）
npm run test:host    # 仅 host 测试（命令、schema、契约）
npm run test:client  # client DOM 集成测试
```

CI（`.github/workflows/ci.yml`）在 push/PR 时运行：在 Node 20 与 22 上执行语法检查 + 完整测试套件，外加一个 `npm pack --dry-run` 包完整性检查任务。

## 许可证

MIT
