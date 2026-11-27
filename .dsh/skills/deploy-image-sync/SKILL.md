---
name: deploy-image-sync
description: Use when deploying, self-hosting, or troubleshooting this repository (dockerImageSync) — a Docker Hub/quay.io → Huawei Cloud SWR image sync tool built from a Cloudflare Worker, GitHub Actions, and a static frontend. 适用于：部署本项目、自建实例、迁移到自己的 GitHub/Cloudflare 账号、排查无法触发同步或登录失败。与用户交互一律使用中文。
whenToUse: 用户说「部署这个项目」「帮我部署」「怎么自建一套」「迁移到我自己的账号」「同步触发不了」「登录不上」时。交互语言：中文。
metadata:
  project: dockerImageSync
  stack: cloudflare-workers|github-actions|huawei-cloud-swr
  interaction-language: zh-CN
---

# 部署 dockerImageSync

目标：把用户从「刚克隆仓库」带到「有一个能用的地址，能提交同步并看到结果」。

## 语言与交互规则（必须遵守）

- **所有面向用户的文字都用中文**：提问、确认、进度、报错解释、最终总结。代码、命令、配置键名、错误原文保持原样，不要翻译。
- **一次只问一组关键信息**，能列选项时给编号；不要让用户面对一张八项清单一次填完。
- **不要猜凭证**。缺什么就让用户去取，并说清在哪个控制台页面取。
- **动手前先说明**：修改文件、推送仓库、部署、写入 secret 之前，用一句中文说清要做什么。
- **破坏性操作必须先确认**：删除云资源、轮换/撤销密钥、把镜像设为公开（等于对公网开放）。
- **每完成一步用一行中文汇报**：做了什么、成功还是失败、关键返回值（URL、run id、HTTP 状态码）。
- 报错时给出「原因 + 下一步动作」，不要只贴堆栈。

## 先分清四类凭证

这是自部署最容易搞混的地方，先讲清楚再动手：

| 凭证 | 存放位置 | 谁在用 |
|---|---|---|
| 华为云 SWR 登录用户名/密码 + AK/SK + 项目 ID | **GitHub Secrets** | Actions 工作流（推镜像、设为公开） |
| GitHub Fine-grained PAT | **Worker Secret** | Worker（触发工作流、查运行状态） |
| Cloudflare API Token + Account ID | **只在部署时的本地环境** | `wrangler deploy`（不随代码分发） |
| 前端口令 | **Worker Secret** | 网页登录 |

## 动手前需要收集的信息

逐项向用户确认，不要用默认值推测：

1. **GitHub 仓库** `owner/repo`：用户必须能推送，且能改 `.github/workflows/`。
2. **SWR Registry 域名**，如 `swr.cn-east-4.myhuaweicloud.com`。必须问，不能假设——它要和 `auth.yaml` 逐字一致。
3. **SWR 组织名**，如 `ascend-sync`，必须在控制台已创建。
4. **长期登录指令**的用户名（`区域@AK`）与密钥 → `SWR_USERNAME`、`SWR_PASSWORD`。
   明确拒收 24 小时临时登录指令，否则之后的同步都会失败。
5. **AK/SK + 项目 ID** → `SWR_AK`、`SWR_SK`、`SWR_PROJECT_ID`。
   项目 ID 在「我的凭证 → 项目列表」里，选名称等于目标区域的那一行。
   IAM 用户需要 SWR 写权限，`SWR FullAccess` 足够。
6. **GitHub Fine-grained PAT**：`Contents`、`Actions`、`Workflows` 三项都要 Read and write，并且只限定这一个仓库。缺 `Workflows` 时推送 `.github/workflows/` 会被拒。
7. **Cloudflare API Token**：`Workers Scripts:Edit` + `Account Settings:Read`，以及 Account ID。
8. **前端口令**：用户没想法就生成一个随机串给他。

如果用户还没有 AK/SK：说明「仍然能同步镜像，只是不会自动设为公开」，让他决定现在补还是之后补，不要卡住整个部署。

## 执行步骤

以下命令默认在仓库根目录执行。

### 1. 确认目录结构与区域

应存在：`.github/workflows/sync-images.yml`、`auth.yaml`、`worker/index.js`、`worker/wrangler.toml`、`web/index.html`、`web/app.js`、`scripts/make_repo_public.py`。

然后对齐区域，**两处必须与用户的 registry 域名一致**：

- `auth.yaml` 的 key：就是 registry 域名，不带协议、不带路径。
- Worker 的 `SWR_REGISTRY`（默认 `swr.cn-east-4.myhuaweicloud.com`）与 `SWR_ORG`（默认 `ascend-sync`）。

这里不一致，是「推送时报 authentication required」最常见的原因。

### 2. 推送到用户的 GitHub 仓库

```sh
git init && git add -A
git commit -m "Initial commit: image sync system"
git branch -M main
git remote add origin https://github.com/OWNER/REPO.git
git push -u origin main
```

任何真实凭证都不要提交；`.gitignore` 已排除 `.env`、`.dev.vars`、`local/`、`*.log`。若推送报 403 且提到 `workflow`，是 PAT 缺 `Workflows` 权限。

### 3. 配置 GitHub Secrets

在 `Settings → Secrets and variables → Actions` 添加：`SWR_USERNAME`、`SWR_PASSWORD`、`SWR_AK`、`SWR_SK`、`SWR_PROJECT_ID`。

可选：`SOURCE_DOCKERHUB_USER` / `SOURCE_DOCKERHUB_PASS`（Docker Hub 只读 Token，用于规避匿名拉取限流）。

用网页或 API 配置，不要把密钥写进仓库文件。

### 4. 部署 Worker 与静态页面

`worker/wrangler.toml` 已配置 `[assets] directory = "../web"`，一次部署同时提供 API 和页面（同源，无需 CORS、无需 `PROXY_URL`）。

```sh
cd worker
npx wrangler@latest deploy
```

认证方式二选一：环境变量 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`；或 `npx wrangler login`。命令结束会打印访问地址。

### 5. 写入 Worker Secrets

```sh
cd worker
npx wrangler@latest secret put GITHUB_REPO      # owner/repo
npx wrangler@latest secret put WORKFLOW_ID      # sync-images.yml
npx wrangler@latest secret put GITHUB_TOKEN     # Fine-grained PAT
npx wrangler@latest secret put APP_PASSWORD     # 网页登录口令
```

可选：`SWR_REGISTRY`、`SWR_ORG`、`ALLOWED_ORIGIN`。

`APP_PASSWORD` 是**必需**的：未配置时所有接口按设计返回 500，保证部署不会处于无鉴权状态。这一点要让用户知道，否则他会以为部署失败。

### 6. 端到端验证

不要只凭「部署成功」就交付，按顺序验证：

```sh
# 页面与登录闸门
curl -s https://<worker-url>/ | head -5
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-url>/api/config            # 期望 401

# 登录
RESP=$(curl -s -X POST https://<worker-url>/api/login \
  -H 'Content-Type: application/json' -d '{"password":"<APP_PASSWORD>"}')
TOKEN=$(printf '%s' "$RESP" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

# 带令牌的接口
curl -s https://<worker-url>/api/config -H "Authorization: Bearer $TOKEN"
curl -s "https://<worker-url>/api/runs?limit=5" -H "Authorization: Bearer $TOKEN"
```

然后用一个小镜像真实跑一次（`docker.io/library/hello-world:latest`，`arch=amd64`），确认 Actions 运行里这三步状态：

- `Generate images.yaml from inputs`
- `Run image-syncer`
- `Set SWR repositories public`（调用方传了 `public: false` 时显示 skipped）

最后确认 SWR 控制台出现镜像；若已设为公开，`docker pull <目标地址>` 应能匿名拉取成功。

## 会让部署失败的约束

- `auth.yaml` 的 key 必须与目标 hostname 逐字一致，不带 `https://`、不带结尾路径。
- SWR 组织必须先存在，否则推送报 `organization not found`。
- 必须用长期有效登录指令，不要用 24 小时临时指令。
- 工作流里「设为公开」那步的条件是 `github.event.inputs.public != 'false'`，不要随手改结构。
- `*.workers.dev` 在中国大陆经常无法直连（需要代理）。要公网可用就得规划自定义域名，见 `references/cloudflare.md`；不要把 workers.dev 地址当作国内稳定入口承诺给用户。
- 多架构镜像很大（nginx 双架构也有数十到数百 MB）。网页上的「目标架构」**没有默认值、必填**，用户必须显式选择；工作流 input 的默认 `amd64` 只对直接调 API/手动 dispatch 生效。
- `all` 的语义是「全部平台」，但实现上只同步 **amd64 + arm64**（`--arch=amd64 --arch=arm64`），不同步 386/ppc64le/riscv64/s390x。要改变这一点需同时改工作流与文档，不要只在一边改。
- 架构与镜像提供的平台不匹配时，`Run image-syncer` 步骤会显式失败并提示「架构不匹配」，不要把它当成偶发故障。
- 网页上的组织名默认是**锁定**状态，这是刻意设计；解锁要用户主动点。

## 出问题时

先读 `references/troubleshooting.md`，再改代码。里面按真实报错字符串列了原因（GitHub 的 401/403/422、`authentication required`、`exec format error`、Cloudflare `1010`、`ERR_TUNNEL_CONNECTION_FAILED` 等），并标注了哪些问题已经修过一次、不要换种方式再"修"。

更细的内容：`references/cloudflare.md`、`references/huaweicloud.md`（这两个文件是英文技术备忘，读给模型用；对用户复述时仍用中文）。