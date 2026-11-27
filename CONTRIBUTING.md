# Contributing

本文件约定本仓库的提交信息格式、代码风格与验证流程。文档本身用中文，**提交信息一律使用英文**。

---

## 1. 提交信息规范

### 1.1 基本格式

```
<type>(<scope>): <subject>

[可选正文]
```

- 一行标题不超过 **72 个字符**
- `subject` 用**英文祈使句**（`add` / `fix` / `drop` / `bump`），首字母小写，**结尾不加句号**
- 正文（可选）说明 **为什么** 改，而不是重复改了什么
- 严禁混用中文提交信息（专有名词如服务名可以保留原有拼写）

### 1.2 type

| type | 用途 |
|---|---|
| `feat` | 新增功能 |
| `fix` | 修复缺陷 |
| `docs` | 只改文档（README / SKILL / 注释性说明） |
| `style` | 不影响行为的样式、格式、文案排版 |
| `refactor` | 既不修 bug 也不加功能的结构调整 |
| `perf` | 性能优化 |
| `chore` | 构建、依赖、CI、杂务 |
| `revert` | 回滚某次提交 |

### 1.3 scope

| scope | 对应目录 |
|---|---|
| `web` | `web/`（前端页面与脚本） |
| `worker` | `worker/`（Cloudflare Worker、D1） |
| `workflow` | `.github/workflows/` |
| `scripts` | `scripts/` |
| `skill` | `.dsh/skills/` |
| `docs` | `README.md`、`docs/`、本文件 |
| `ci` | 与工作流/部署相关的 CI 配置 |
| `deps` | 依赖版本变更 |

scope 可省略（跨多个部分时）。

### 1.4 示例

```text
feat(web): add arch chips with required validation
fix(worker): reject tokens whose role was tampered with
docs: document D1 search and admin delete semantics
style(web): drop trailing wording from dual-arch chip
chore(ci): bump actions/checkout to v5 (Node 24)
feat(workflow): add stall watchdog that aborts runs without progress
```

反例（不要这样写）：

```text
update               # 没说明改了什么
fix bug              # 太笼统
feat: 修复同步失败     # 中文，且 type 与内容不符
Add New Feature.     # 大写开头 + 句号 + 空泛
```

### 1.5 破坏性变更

在 type 后加 `!`，并在正文里写清影响与迁移方式：

```text
feat(worker)!: change token format to v1.<role>.<exp>.<sig>

All previously issued tokens are invalidated; users must log in again.
```

### 1.6 一次提交只做一件事

- 不要把"功能 + 样式微调 + 文档"塞进同一个提交（除非它们属于同一个不可分割的改动）
- 但也不要为同一目的制造一串 `fix typo` / `再改一下间距` —— 相邻的同类微调请在推送前合并

---

## 2. 分支与推送

- 单人维护，允许直接提交 `main`
- 较大的改动建议开分支，合并前自测
- **改写历史后必须用 `--force-with-lease`**，并显式指定期望的远程提交，避免覆盖他人推送：

```bash
git push --force-with-lease=refs/heads/main:<期望的远程 SHA> <url> main:main
```

> 本仓库的远程地址在 `.git/config` 中**不含令牌**；推送时使用内联的临时凭据，不要在仓库里留下任何 token。

---

## 3. 改动后必须做的验证

### 3.1 语法与静态检查

```bash
node --check web/app.js
node --check worker/index.js
```

前端与 Worker 都是无构建的原生 JS，语法错误只能在运行时暴露，所以这一步不能省。

### 3.2 CSS 结构

`web/index.html` 的样式写在单个 `<style>` 内，改动后确认括号平衡：

```bash
python3 - <<'PY'
import re
h = open('web/index.html', encoding='utf-8').read()
css = re.search(r'<style>(.*?)</style>', h, re.S).group(1)
assert css.count('{') == css.count('}')
print('CSS OK')
PY
```

### 3.3 部署并实测

```bash
cd worker
npx wrangler@latest deploy

# 页面与鉴权
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-url>/            # 200
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-url>/api/config  # 401
```

涉及同步链路的改动，**必须真跑一次同步**并确认：

- `Generate images.yaml from inputs` / `Run image-syncer` / 设为公开 三步状态正确
- 目标 tag 的 manifest 平台与所选架构一致
- 失败场景下 Job Summary 有中文分类

### 3.4 文档同步

行为变了就同步文档：`README.md`（对使用者）与 `.dsh/skills/deploy-image-sync/`（对 Agent）。两者描述冲突时以代码为准，并立即修正文档。

---

## 4. 代码约定

### 前端（`web/`）

- 原生 HTML/CSS/JS，**不引入构建工具与框架**
- 主题通过 CSS 变量（`--bg` / `--text` / `--accent` …）实现，新增颜色先加变量
- 插入动态文本用 `textContent`，禁止拼接 HTML 字符串（防 XSS）
- 配色语义：红色只用于**不可逆**动作（删除按钮、已删除标记）；选中态用主题蓝

### Worker（`worker/`）

- 所有响应经 `jsonResponse()`，错误统一 `{ error: "..." }`
- 新接口默认 `requireAuth()`；破坏性接口用 `requireAuth(request, env, { requireAdmin: true })`
- 角色信息来自令牌签名，**不要信任前端传来的 role**
- D1 查询参数一律用 `bind()`，不要字符串拼接
- 索引写入失败只记日志，**不能影响主流程**（触发同步、返回状态）

### 工作流（`.github/workflows/`）

- 面向用户的信息用**中文**（Job Summary、失败注解）
- 失败要显式：架构不匹配、无进展都要让步骤 `exit` 非 0
- 不要在 `run:` 里用列 1 的 heredoc（会破坏 YAML），用 `printf`

### Python 脚本（`scripts/`）

- 只用标准库，避免在 Actions 里额外装包
- 分类脚本必须**始终退出 0**（它只负责解释失败，不改变结论）

---

## 5. 文件与格式

- 所有文本文件使用 **UTF-8**、**LF** 换行
- 用脚本批量改写文件时显式指定换行，避免 Windows 下被转成 CRLF：

```python
path.write_text(text, encoding='utf-8', newline='\n')
```

- 不提交 `.env`、`.dev.vars`、`local/`、日志与 `__pycache__/`（见 `.gitignore`）

---

## 6. 安全底线

- 任何令牌、口令、AK/SK 都只通过 `wrangler secret put` 或 GitHub Secrets 注入，**不写进代码与文档**
- `ADMIN_PASSWORD` 未配置时，删除接口必须返回 `501`；不要为了"功能完整"擅自开启破坏性能力
- 删除历史记录 = GitHub 运行及日志**真删** + D1 标记 `deleted_at`，两者必须同时做
- 改动鉴权、删除、公开镜像这类能力时，先在提交正文里说明风险

---

## 7. 部署速查

```bash
# 前端 + Worker（同一个 Worker 托管静态资源）
cd worker && npx wrangler@latest deploy

# 更新口令 / 管理员口令
cd worker && npx wrangler@latest secret put APP_PASSWORD
cd worker && npx wrangler@latest secret put ADMIN_PASSWORD

# 关闭删除能力
cd worker && npx wrangler@latest secret delete ADMIN_PASSWORD

# D1 表结构
cd worker && npx wrangler@latest d1 execute image-sync-index --remote --file=schema.sql
```

完整自部署流程见 `README.md` 的「自部署」一节，或使用 `.dsh/skills/deploy-image-sync/` 技能辅助完成。