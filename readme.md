
# 容器镜像自动同步系统 · 实现规格说明（华为云 SWR 版）

## 1. 项目目标

构建一个零常驻服务器成本的容器镜像同步系统，支持用户通过 Web 前端输入 Docker Hub / quay.io 的镜像地址，自动同步到**华为云 SWR**。同步执行引擎为 GitHub Actions 上的 `image-syncer`，触发入口为静态前端 + Serverless 代理。

## 2. 整体架构

```
[静态前端 Static Frontend]
        │  POST /api/sync  { source, destination, tags }
        ▼
[Serverless 代理 Serverless Proxy]
        │  POST GitHub API /actions/workflows/{id}/dispatches
        ▼
[GitHub Actions Workflow]
        │  workflow_dispatch inputs 动态生成 images.yaml
        ▼
[image-syncer]  ──拉取──▶ Docker Hub / quay.io
                ──推送──▶ 华为云 SWR
```

职责边界：
- **前端**：仅收集用户输入并调用代理接口，不持有任何凭证。
- **代理**：持有 GitHub Fine-grained Token，做参数校验和转发，不接触云厂商凭证。
- **Workflow**：持有 SWR 凭证（GitHub Secrets），实际执行同步。

## 3. 技术栈

| 层 | 选型 |
|---|---|
| 同步引擎 | `image-syncer`，通过 `hhyasdf/image-sync-action@v1.1` 调用 |
| CI/CD | GitHub Actions（`workflow_dispatch` 触发） |
| 代理 | Cloudflare Worker（或 Vercel Edge Function，二选一） |
| 前端 | 原生 HTML/JS 或 Vue 3 + Vite，部署到 Cloudflare Pages |
| 认证 | GitHub Fine-grained Token + GitHub Secrets 存 SWR 凭证 |

## 4. 仓库目录结构

```
repo/
├── .github/
│   └── workflows/
│       └── sync-images.yml        # 同步工作流
├── auth.yaml                      # image-syncer 认证配置（引用环境变量）
├── images.yaml                    # 默认同步规则（可被 workflow 覆盖生成）
├── worker/
│   └── index.js                   # Serverless 代理
└── web/
    ├── index.html                 # 前端页面
    └── app.js                     # 前端逻辑
```

## 5. 组件规格

### 5.1 Workflow：`.github/workflows/sync-images.yml`

**触发方式**：`workflow_dispatch`，接收三个 inputs。

| input | 必填 | 类型 | 说明 |
|---|---|---|---|
| `source` | 是 | string | 源镜像地址，如 `docker.io/library/nginx:1.25.3` 或 `quay.io/prometheus/node-exporter:v1.7.0` |
| `destination` | 是 | string | 目标镜像地址，如 `swr.cn-north-4.myhuaweicloud.com/your-org/nginx:1.25.3` |
| `tags` | 否 | string | 逗号分隔的 tag 列表；留空时若源地址带 tag 则只同步该 tag（默认单 tag），源地址不带 tag 则同步全部；显式填 `all` 强制同步全部 |

**Jobs 步骤**：
1. `actions/checkout@v4` 检出仓库。
2. 运行 shell 脚本，根据 inputs **动态生成 `images.yaml`**：
   - 若 `tags` 显式给出（非空且不为 `all`），对每个 tag 生成一条 `<source>:<tag> → <destination>:<tag>` 规则。
   - 若 `tags` 为空且 `source` 自带 tag（如 `nginx:1.25.3`），只生成该单 tag 的同步规则（默认行为，避免误触发全量同步）。
   - 若 `tags` 为空且 `source` 不带 tag，或 `tags=all`，规则写为 `"<source-without-tag>: <destination-without-tag>"`（全 tag 同步）。
3. 调用 `hhyasdf/image-sync-action@v1.1`，传入 `auth_file: ./auth.yaml`、`images_file: ./images.yaml`、`proc: 6`。
4. 在 `env` 中注入 Secrets：`SWR_USERNAME`、`SWR_PASSWORD`，以及可选的 Docker Hub / Quay 源端凭证。

**关键约束**：`auth.yaml` 固定来自仓库，不接受前端传入；工作流只覆盖 `images.yaml`。

### 5.2 认证文件：`auth.yaml`

以 Registry 域名为 key，value 含 `username` / `password`，值使用 `${ENV_VAR}` 占位符由环境变量注入。**仅保留华为云 SWR 段**，源端凭证按需添加：

```yaml
swr.cn-north-4.myhuaweicloud.com:      # 替换为你的 SWR Registry 地址
  username: ${SWR_USERNAME}
  password: ${SWR_PASSWORD}

# 以下仅在同步私有源镜像时保留，公有镜像可删除
docker.io:
  username: ${SOURCE_DOCKERHUB_USER}
  password: ${SOURCE_DOCKERHUB_PASS}
quay.io:
  username: ${SOURCE_QUAY_USER}
  password: ${SOURCE_QUAY_PASS}
```

**约束**：key 必须与镜像地址中的 hostname 完全一致（不带 `https://`、不带路径）。若只同步公有镜像，`auth.yaml` 可精简到只保留 SWR 一段。

### 5.3 Serverless 代理：`worker/index.js`

**接口**：`POST /api/sync`
**请求体**：`{ "source": string, "org"?: string }`
（兼容旧参数 `{ "destination": string, "tags": string }`，显式传 `destination` 时不再推导）
**响应**：`200 { "ok": true, "run_id": number, "html_url": string, "destination": string }` / `400 { "error": string }` / `502 { "ok": false, "error": string }`

**配置查询**：`GET /api/config`
**响应**：`200 { "ok": true, "registry": string, "default_org": string }`（前端用于展示目标路径预览）

**进度查询**：`GET /api/status?id=<run_id>`
**响应**：`200 { "ok": true, "status": "queued|in_progress|completed", "conclusion": string, "html_url": string, "steps": [{ "name": string, "status": string, "conclusion": string }] }` / `400 / 404 / 502`

**逻辑**：
1. `/api/sync` 仅接受 POST，`/api/status`、`/api/config` 仅接受 GET；其余返回 405。
2. 校验 `source` 非空且可解析，否则 400。
3. **自动推导目标地址**（前端只需填源地址）：`{SWR_REGISTRY}/{org}/{源最后一段仓库名}:{tag}`，其中 `tag` 取源地址中的 tag，缺省为 `latest`；`org` 取请求参数 `org`，缺省为 `SWR_ORG`（`ascend-sync`）。组织名非法返回 400。
4. 从环境变量读取 `GITHUB_REPO`（`owner/repo`）、`WORKFLOW_ID`（文件名如 `sync-images.yml`）、`GITHUB_TOKEN`。
5. 向 `https://api.github.com/repos/{repo}/actions/workflows/{workflowId}/dispatches` 发起 POST，body 为：
   ```json
   { "ref": "main", "inputs": { "source": "...", "destination": "<推导结果>", "tags": "" } }
   ```
   Header 必须含 `Authorization: Bearer <token>`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`。
6. 根据 GitHub 返回状态码映射响应，并设置 CORS 头 `Access-Control-Allow-Origin`（生产环境应限定为前端域名，可用 `ALLOWED_ORIGIN` 环境变量配置）。
7. dispatch 成功后轮询最近运行列表，定位本次触发的 `run_id` 与 `html_url` 返回给前端；`/api/status` 按 `run_id` 查询运行状态与步骤，供前端展示实时进度。

**Worker 环境变量**：`GITHUB_REPO`、`WORKFLOW_ID`、`GITHUB_TOKEN`；可选 `SWR_REGISTRY`（默认 `swr.cn-east-4.myhuaweicloud.com`）、`SWR_ORG`（默认 `ascend-sync`）、`ALLOWED_ORIGIN`。

### 5.4 前端：`web/index.html` + `web/app.js`

**页面元素**：源镜像输入框、目标组织输入框（默认 `ascend-sync`）、目标路径实时预览、提交按钮、进度面板、结果提示区。

**行为**：
1. 提交时阻止默认表单行为，校验源镜像地址非空且可解析。
2. 前端按与 Worker 相同的规则在本地预览目标路径（`GET /api/config` 获取 registry 与默认组织），用户无需填写目标地址。
3. `fetch(PROXY_URL + '/api/sync', { method: 'POST', body: JSON.stringify({ source, org }) })`。
4. 触发成功后若返回 `run_id`，每 8 秒轮询 `GET /api/status?id=<run_id>`，在进度面板展示整体状态（排队中/同步中/成功/失败）和各步骤状态，完成后给出明确结果提示；跟踪超时（60 分钟）则提示前往 Actions 查看。
5. 若触发成功但未拿到 `run_id`，降级为“已触发，请前往 Actions 页面查看”。
6. 进度与最近记录持久化在 `localStorage`：刷新页面后自动恢复上次同步状态（若仍未结束会继续轮询），并展示最近 10 条同步记录（含结果与日志链接），可一键清空。
7. `PROXY_URL` 通过构建时注入或页面顶部常量配置，不硬编码在逻辑深处。

**约束**：前端代码中**不得出现任何 GitHub Token 或 SWR 凭证**。

## 6. 凭证与配置清单

| 存放位置 | 名称 | 用途 |
|---|---|---|
| GitHub Secrets | `SWR_USERNAME` | 华为云 SWR 长期登录用户名（`区域项目名@AK`，如 `cn-north-4@XXXXXXXX`） |
| GitHub Secrets | `SWR_PASSWORD` | 华为云 SWR 长期登录密钥 |
| GitHub Secrets | `SOURCE_DOCKERHUB_USER` / `_PASS` | 可选，私有 Docker Hub 镜像 |
| GitHub Secrets | `SOURCE_QUAY_USER` / `_PASS` | 可选，私有 Quay 镜像 |
| Worker 环境变量 | `GITHUB_REPO` | `owner/repo` |
| Worker 环境变量 | `WORKFLOW_ID` | `sync-images.yml` |
| Worker 环境变量 | `GITHUB_TOKEN` | Fine-grained Token，需 Contents / Actions / Workflows 读写 |
| Worker 环境变量 | `SWR_REGISTRY` | 可选，目标 SWR 域名，默认 `swr.cn-east-4.myhuaweicloud.com` |
| Worker 环境变量 | `SWR_ORG` | 可选，默认目标组织，默认 `ascend-sync` |
| 前端配置 | `PROXY_URL` | Worker 部署地址 |

## 7. 实施步骤

1. 创建仓库，按第 4 节目录结构落盘所有文件。
2. 在 GitHub 仓库 Secrets 中配置 `SWR_USERNAME` / `SWR_PASSWORD`（及可选的源端凭证）。
3. **在 SWR 控制台预先创建目标组织（Organization）**，并获取长期有效登录指令中的用户名与密钥。
4. 创建 GitHub Fine-grained Token（仅 Actions: Read & Write，限定单仓库），填入 Worker 环境变量。
5. 部署 Worker（`wrangler deploy` 或 Vercel 控制台导入），配置三个环境变量。
6. 部署前端到 Cloudflare Pages，配置 `PROXY_URL` 指向 Worker。
7. 手动触发一次 workflow，验证 `images.yaml` 生成与同步结果。
8. 通过前端页面触发一次，验证端到端链路。

## 8. 验收标准

- [ ] 从前端页面只填 `source=docker.io/library/nginx:1.25.3`，自动同步到 `swr.cn-east-4.myhuaweicloud.com/ascend-sync/nginx:1.25.3`，Actions 出现新 run 并最终成功。
- [ ] 前端修改目标组织（如 `my-org`）后，目标路径变为 `swr.../my-org/nginx:1.25.3`。
- [ ] 传入不存在的源镜像时，workflow 失败并在日志中给出明确错误，前端收到“已触发”响应（触发成功与同步成败解耦）。
- [ ] 前端源码与 Worker 源码中不包含任何 SWR AK/SK 或 GitHub Token 明文。
- [ ] `tags` 留空且源地址带 tag 时，workflow 只同步该 tag；源地址不带 tag 时，生成全 tag 同步规则（源地址不含 tag）。
- [ ] 重复触发同一镜像，`image-syncer` 日志显示 skipped 而非重复传输（增量同步生效）。
- [ ] 直连 API 传入非 `swr.` 的 `destination` 时，代理返回 400 并提示“目标仓库仅支持华为云 SWR”。
- [ ] 前端触发后可实时看到运行状态与步骤进度，完成后展示“同步成功/失败”结果。

## 9. 注意事项（实现时必须遵守）

1. `auth.yaml` 中 SWR 的 Registry key 必须与镜像 URL hostname 逐字一致，否则认证失败。
2. 华为云 SWR 的目标组织（Organization）需提前在控制台创建，否则推送报错。
3. SWR 凭证使用**长期有效登录指令**（基于 AK/SK 生成），不要使用 24 小时临时登录指令，否则定时同步会在凭证过期后失败。
4. GitHub Token 使用 Fine-grained Token，仅授予目标仓库的 Contents / Actions / Workflows 读写权限，禁止使用 classic token 或全权限 token。
5. Worker 的 CORS 在生产环境应限定为前端实际域名，避免任意站点调用。
6. 若使用 Vercel 替代 Cloudflare Worker，接口契约与请求体保持不变，仅部署方式和环境变量配置入口不同。
7. 代理层对 `destination` 做 `swr.` 域名前缀校验，是低成本防止误推送至其他仓库的有效手段，建议保留。

