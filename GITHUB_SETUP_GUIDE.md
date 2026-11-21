# GitHub 配置指南

本指南帮助你完成容器镜像同步系统的 GitHub 配置。

---

## 一、创建 GitHub 仓库

### 1.1 在本地初始化 Git 仓库

```bash
cd C:\Users\Jason\Downloads\imageSync

# 初始化 Git 仓库
git init

# 添加所有文件
git add .

# 提交
git commit -m "Initial commit: image sync system"

# 创建 main 分支（GitHub 默认分支）
git branch -M main
```

### 1.2 在 GitHub 创建远程仓库

1. 访问 https://github.com/new
2. 填写信息：
   - **Repository name**: `image-sync`（或其他名称）
   - **Description**: `容器镜像自动同步系统`
   - **Public/Private**: 选择 Private（推荐）
   - **不要勾选** "Add a README file"（我们已有）
3. 点击 **Create repository**

### 1.3 关联远程仓库并推送

```bash
# 替换为你的 GitHub 用户名和仓库名
git remote add origin https://github.com/YOUR_USERNAME/image-sync.git

# 推送代码
git push -u origin main
```

---

## 二、配置 GitHub Secrets

### 2.1 获取华为云 SWR 长期登录凭证

1. 登录 [华为云控制台](https://console.huaweicloud.com/)
2. 进入 **容器镜像服务 SWR**
3. 左侧菜单 → **系统管理** → **长期有效登录指令**
4. 点击 **生成登录指令**
5. 记录以下信息：
   - **用户名**: 格式为 `区域项目名@AK`，如 `cn-north-4@XXXXXXXX`
   - **密码**: 生成的长期密钥

> ⚠️ **重要**: 必须使用"长期有效登录指令"，不要使用 24 小时临时登录指令！

### 2.2 在 GitHub 配置 Secrets

1. 进入你的 GitHub 仓库页面
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**
4. 依次添加以下 Secrets：

| Name | Value | 说明 |
|---|---|---|
| `SWR_USERNAME` | `cn-north-4@XXXXXXXX` | 华为云 SWR 长期登录用户名 |
| `SWR_PASSWORD` | `xxxxxxxxxxxxxxxx` | 华为云 SWR 长期登录密码 |

> **可选**（仅同步私有镜像时需要）：
> 
> | Name | Value |
> |---|---|
> | `SOURCE_DOCKERHUB_USER` | Docker Hub 用户名 |
> | `SOURCE_DOCKERHUB_PASS` | Docker Hub 密码或 Access Token |
> | `SOURCE_QUAY_USER` | Quay.io 用户名 |
> | `SOURCE_QUAY_PASS` | Quay.io 密码 |

### 2.3 验证 Secrets 配置

配置完成后，你的 Secrets 列表应包含：
- ✅ `SWR_USERNAME`
- ✅ `SWR_PASSWORD`
- （可选）`SOURCE_DOCKERHUB_USER`、`SOURCE_DOCKERHUB_PASS`
- （可选）`SOURCE_QUAY_USER`、`SOURCE_QUAY_PASS`

---

## 三、创建 Fine-grained Personal Access Token

### 3.1 创建 Token

1. 访问 https://github.com/settings/tokens?type=beta
2. 点击 **Generate new token**
3. 填写信息：
   - **Token name**: `image-sync-worker`
   - **Description**: `用于触发镜像同步工作流`
   - **Expiration**: 选择有效期（建议 90 天，到期后需重新生成）
   - **Resource owner**: 选择你的用户名或组织
   - **Repository access**: 选择 **Only select repositories** → 选择 `image-sync` 仓库
   - **Permissions** → **Repository permissions**:
     - **Actions**: 设置为 **Read and write**
     - 其他权限保持 **No access**

4. 点击 **Generate token**
5. **立即复制 Token**（格式：`github_pat_xxxxxxxxxxxx`），后续无法再次查看

### 3.2 安全保存 Token

将 Token 保存到安全位置（如密码管理器），后续配置 Worker 环境变量时需要使用。

> ⚠️ **安全提示**: 
> - 不要将 Token 提交到代码仓库
> - 不要分享给他人
> - Token 泄露时立即在 GitHub 撤销

---

## 四、验证 Workflow 配置

### 4.1 手动触发一次 Workflow

1. 进入 GitHub 仓库页面
2. 点击 **Actions** 标签
3. 左侧选择 **Sync Container Images**
4. 点击 **Run workflow** → **Run workflow**
5. 填写测试参数：
   - **source**: `docker.io/library/nginx:1.25.3`
   - **destination**: `swr.cn-north-4.myhuaweicloud.com/YOUR_ORG/nginx:1.25.3`
     - 将 `YOUR_ORG` 替换为你在 SWR 控制台创建的组织名称
   - **tags**: 留空
6. 点击 **Run workflow**

### 4.2 检查执行结果

1. 刷新页面，查看新的 workflow run
2. 点击进入查看详情
3. 展开 **Generate images.yaml from inputs** 步骤，检查生成的规则：
   ```yaml
   docker.io/library/nginx: swr.cn-north-4.myhuaweicloud.com/YOUR_ORG/nginx
   ```
4. 展开 **Run image-syncer** 步骤，查看同步日志
5. 成功标志：日志显示镜像已推送到 SWR

### 4.3 在 SWR 控制台验证

1. 登录华为云 SWR 控制台
2. 进入 **我的镜像** → 选择你的组织
3. 查看是否出现 `nginx` 镜像
4. 点击进入，确认 tag `1.25.3` 存在

---

## 五、常见问题排查

### Q1: Workflow 报错 `authentication required`

**原因**: SWR 凭证配置错误

**解决**:
- 检查 `SWR_USERNAME` 格式是否为 `区域项目名@AK`
- 确认使用的是"长期有效登录指令"而非临时指令
- 重新生成并更新 Secrets

### Q2: Workflow 报错 `organization not found`

**原因**: SWR 目标组织未创建

**解决**:
- 进入 SWR 控制台 → **组织管理** → **创建组织**
- 确保 `destination` 中的组织名与控制台一致

### Q3: Workflow 报错 `unauthorized` 或 `403`

**原因**: Fine-grained Token 权限不足

**解决**:
- 检查 Token 是否授予了目标仓库的 **Actions: Read and write** 权限
- 确认 Token 未过期

### Q4: 同步成功但 SWR 看不到镜像

**原因**: 组织名称或镜像路径错误

**解决**:
- 检查 `destination` 格式：`swr.REGION.myhuaweicloud.com/ORG/IMAGE:TAG`
- 确认 ORG 在 SWR 控制台已创建

---

## 六、下一步

GitHub 配置完成后，继续部署 Worker 和前端：

1. **部署 Worker**: 参考 `worker/README.md`（待创建）
2. **部署前端**: 将 `web/` 目录部署到 Cloudflare Pages
3. **端到端测试**: 通过前端页面触发同步，验证完整链路

---

## 配置检查清单

完成所有配置后，确认以下项目：

- [ ] GitHub 仓库已创建并推送代码
- [ ] `SWR_USERNAME` Secret 已配置
- [ ] `SWR_PASSWORD` Secret 已配置
- [ ] （可选）源端凭证 Secrets 已配置
- [ ] Fine-grained Token 已创建并安全保存
- [ ] Workflow 手动触发测试成功
- [ ] SWR 控制台确认镜像已同步
