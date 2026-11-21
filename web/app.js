/**
 * 前端逻辑 — 容器镜像同步
 *
 * 只需填源镜像地址：目标路径由 Worker 按 SWR_REGISTRY + 组织自动推导。
 * 注意：此处不得出现任何 GitHub Token 或 SWR 凭证。
 */

// ============================================================
// 配置：部署时替换为 Worker 实际地址
// 同源部署（local/server.mjs）时会注入 ''，即直接请求当前服务
// ============================================================
const PROXY_URL = (window.PROXY_URL || 'https://your-worker.your-subdomain.workers.dev').replace(/\/$/, '');

const POLL_INTERVAL_MS = 8000;
const POLL_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TAG = 'latest';

// 与 Worker 保持一致的后备默认值（Worker 不可达时用于展示预览）
const FALLBACK_REGISTRY = 'swr.cn-east-4.myhuaweicloud.com';
const FALLBACK_ORG = 'ascend-sync';

// DOM
const form = document.getElementById('syncForm');
const sourceInput = document.getElementById('source');
const orgInput = document.getElementById('org');
const submitBtn = document.getElementById('submitBtn');
const resultDiv = document.getElementById('result');
const previewTarget = document.getElementById('previewTarget');
const progressDiv = document.getElementById('progress');
const statusBadge = document.getElementById('statusBadge');
const stepList = document.getElementById('stepList');
const runLink = document.getElementById('runLink');
const progressTitle = document.getElementById('progressTitle');

let scrollInfo = { registry: FALLBACK_REGISTRY, defaultOrg: FALLBACK_ORG };
let pollTimer = null;
let pollStartedAt = 0;

function showResult(type, message) {
  resultDiv.className = type;
  resultDiv.textContent = message;
}

function setBadge(kind, text) {
  statusBadge.className = `badge ${kind}`;
  statusBadge.textContent = text;
}

/**
 * 解析镜像地址，返回 { repo, tag }（与 Worker 的 parseImage 一致）
 */
function parseImage(source) {
  let s = String(source || '').trim();
  if (!s) return null;
  const at = s.indexOf('@');
  if (at !== -1) s = s.slice(0, at);
  const slash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  let tag = null;
  if (colon > slash) {
    tag = s.slice(colon + 1);
    s = s.slice(0, colon);
  }
  const repo = s.split('/').filter(Boolean).pop();
  if (!repo) return null;
  return { repo, tag: tag || null };
}

function renderPreview() {
  const parsed = parseImage(sourceInput.value);
  if (!parsed) {
    previewTarget.textContent = '填写源镜像地址后自动生成';
    return;
  }
  const org = (orgInput.value || '').trim() || scrollInfo.defaultOrg;
  const tag = parsed.tag || DEFAULT_TAG;
  previewTarget.textContent = `${scrollInfo.registry}/${org}/${parsed.repo}:${tag}`;
}

async function loadConfig() {
  try {
    const resp = await fetch(`${PROXY_URL}/api/config`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && data.ok) {
      scrollInfo.registry = data.registry || FALLBACK_REGISTRY;
      scrollInfo.defaultOrg = data.default_org || FALLBACK_ORG;
      if (!orgInput.value.trim()) orgInput.value = scrollInfo.defaultOrg;
      renderPreview();
    }
  } catch {
    renderPreview();
  }
}

const STEP_ICONS = {
  success: '✅',
  failure: '❌',
  cancelled: '⚪',
  skipped: '⏭️',
  in_progress: '🔄',
  queued: '⏳',
};

function renderSteps(steps) {
  stepList.innerHTML = '';
  (steps || []).forEach((step) => {
    const li = document.createElement('li');
    const cls = step.conclusion || step.status || 'queued';
    if (cls === 'success' || cls === 'failure') li.className = cls;
    else if (step.status === 'in_progress') li.className = 'active';

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = STEP_ICONS[cls] || STEP_ICONS[step.status] || '⏳';

    const name = document.createElement('span');
    name.textContent = step.name;

    li.append(icon, name);
    stepList.appendChild(li);
  });
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function describeStatus(status, conclusion) {
  if (status === 'queued') return { kind: 'queued', text: '排队中' };
  if (status === 'in_progress') return { kind: 'running', text: '同步中…' };
  if (status === 'completed') {
    if (conclusion === 'success') return { kind: 'success', text: '同步成功' };
    if (conclusion === 'cancelled') return { kind: 'cancelled', text: '已取消' };
    if (conclusion === 'skipped') return { kind: 'cancelled', text: '已跳过' };
    return { kind: 'failure', text: '同步失败' };
  }
  return { kind: 'queued', text: status || '处理中' };
}

async function pollStatus(runId, htmlUrl, destination) {
  if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
    showResult('error', '跟踪超时，请点击下方链接前往 Actions 页面查看最终结果');
    stopPolling();
    return;
  }

  try {
    const resp = await fetch(`${PROXY_URL}/api/status?id=${encodeURIComponent(runId)}`);
    const data = await resp.json();

    if (!resp.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${resp.status}`);
    }

    const { kind, text } = describeStatus(data.status, data.conclusion);
    setBadge(kind, text);

    if (data.steps && data.steps.length) {
      renderSteps(data.steps);
    }
    if (data.html_url) {
      runLink.href = data.html_url;
      runLink.style.display = 'inline-block';
    }
    progressTitle.textContent = kind === 'success' ? '同步完成' : kind === 'failure' ? '同步失败' : '同步进度';

    if (data.status === 'completed') {
      stopPolling();
      submitBtn.disabled = false;
      submitBtn.textContent = '开始同步';
      if (data.conclusion === 'success') {
        showResult('success', `✅ 同步完成！已推送到 ${destination || 'SWR'}，可在 SWR 控制台查看。`);
      } else if (data.conclusion === 'cancelled') {
        showResult('error', '⚠️ 同步已被取消。');
      } else {
        showResult('error', '❌ 同步失败，请打开 GitHub Actions 查看日志。');
      }
      return;
    }

    showResult('loading', '正在同步，进度会自动更新…');
    pollTimer = setTimeout(() => pollStatus(runId, data.html_url || htmlUrl, destination), POLL_INTERVAL_MS);
  } catch (err) {
    pollTimer = setTimeout(() => pollStatus(runId, htmlUrl, destination), POLL_INTERVAL_MS * 2);
    showResult('loading', `获取进度失败，稍后重试：${err.message}`);
  }
}

function startTracking(runId, htmlUrl, destination) {
  stopPolling();
  pollStartedAt = Date.now();
  progressDiv.classList.add('visible');
  stepList.innerHTML = '';
  setBadge('queued', '排队中');
  progressTitle.textContent = '同步进度';
  if (htmlUrl) runLink.href = htmlUrl;
  runLink.style.display = htmlUrl ? 'inline-block' : 'none';
  showResult('loading', destination ? `已触发同步：${destination}` : '已触发同步，正在获取进度…');
  pollStatus(runId, htmlUrl, destination);
}

sourceInput.addEventListener('input', renderPreview);
orgInput.addEventListener('input', renderPreview);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  stopPolling();

  const source = sourceInput.value.trim();
  const org = orgInput.value.trim();

  if (!source) {
    showResult('error', '请输入源镜像地址');
    sourceInput.focus();
    return;
  }
  if (!parseImage(source)) {
    showResult('error', '无法解析镜像地址，请检查格式');
    sourceInput.focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '触发中…';
  progressDiv.classList.remove('visible');
  showResult('loading', '正在触发同步任务…');

  try {
    const response = await fetch(`${PROXY_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, org }),
    });

    const data = await response.json();

    if (response.ok && data.ok) {
      if (data.run_id) {
        startTracking(data.run_id, data.html_url, data.destination);
        return;
      }
      submitBtn.disabled = false;
      submitBtn.textContent = '开始同步';
      showResult('success', `✅ 已触发同步${data.destination ? `：${data.destination}` : ''}，请前往 GitHub Actions 页面查看执行进度。`);
      return;
    }

    const errorMsg = data.error || `请求失败 (HTTP ${response.status})`;
    showResult('error', `❌ ${errorMsg}`);
    submitBtn.disabled = false;
    submitBtn.textContent = '开始同步';
  } catch (err) {
    showResult('error', `❌ 网络错误，请检查代理地址是否正确：${err.message}`);
    submitBtn.disabled = false;
    submitBtn.textContent = '开始同步';
  }
});

loadConfig();
