# Changelog

## 0.1.1 — 2026-10-04

- **兼容 dsh 0.2.x 运行时**：`peerDependencies` 的 `@deepseek-ai/dsh-tools` 放宽为
  `^0.1.0-rc.6 || ^0.2.0-rc.2`（0.2.0 的插件准入检查会拒绝只声明 0.1.x 的插件）。
- **修复**：`github_issues` / `github_prs` 的严格输出 schema 补上 `updatedAt`，
  否则每次调用都因输出校验失败（400）。
- **修复**：`github_issues` 的 `per_page` 改为 `min(max(3×maxResults, 15), 100)`，
  避免 issues 端点混排 PR 时整页被过滤清空而误报 “No issues found”。
- **修复**：`cloneRepo()` 新增 `resolveGitBaseUrl()`，git clone 用 `github.com`
  而不是 REST 端点 `api.github.com`（后者必然 403）；GHE 去掉 `/api/v3` 后缀。
- **修复**：客户端 bundle 的注册 id 与 `cordis.patch.yml` 的行名统一为包名
  `dsh-tool-github`（原来是并不存在的 `@dsh-external/dsh-tool-github`）。

## 0.1.0 — 2026-08-21

- Initial open-source release.
- GitHub REST API tools for DeepSeek Harness: `github_bind` / `github_whoami` / `github_unbind` (account binding), `github_repo` / `github_search` / `github_my_repos` / `github_issues` / `github_prs` / `github_content` / `github_comment` / `github_create_issue` / `github_create_pr` (API), and `github_workspace_add` / `github_workspace_list` (workspace integration).
- Browser-side GitHub panel in the web GUI (sidebar icon → account status, workspace list, bind / add-workspace actions), backed by `/github-*` remote commands.
