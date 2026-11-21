/**
 * 前端逻辑 — 容器镜像同步
 *
 * 注意：此处不得出现任何 GitHub Token 或 SWR 凭证。
 */

// ============================================================
// 配置：部署时替换为 Worker 实际地址
// 也可在页面加载前通过 <script>window.PROXY_URL = '...'</script> 覆盖
// ============================================================
const PROXY_URL = (window.PROXY_URL || 'https://your-worker.your-subdomain.workers.dev').replace(/\/$/, '');

const POLL_INTERVAL_MS = 8000;   // 轮询间隔
const POLL_TIMEOUT_MS = 60 * 60 * 1000;  // 最长跟踪 60 分钟

// DOM
const form = document.getElementById('syncForm');
const sourceInput = document.getElementById('source');
const destinationInput = document.getElementById('destination');
const tagsInput = document.getElementById('tags');
const submitBtn = document.getElementById('submitBtn');
const resultDiv = document.getElementById('result');
const progressDiv = document.getElementById('progress');
const statusBadge = document.getElementById('statusBadge');
const stepList = document.getElementById('stepList');
const runLink = document.getElementById('runLink');
const progressTitle = document.getElementById('progressTitle');

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

async function pollStatus(runId, htmlUrl) {
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
        showResult('success', '✅ 同步完成！镜像已推送到华为云 SWR，可在 SWR 控制台查看。');
      } else if (data.conclusion === 'cancelled') {
        showResult('error', '⚠️ 同步已被取消。');
      } else {
        showResult('error', `❌ 同步失败，请打开 GitHub Actions 查看日志。`);
      }
      return;
    }

    // 未完成，继续轮询
    showResult('loading', '正在同步，进度会自动更新…');
    pollTimer = setTimeout(() => pollStatus(runId, data.html_url || htmlUrl), POLL_INTERVAL_MS);
  } catch (err) {
    // 网络抖动：重试一次，避免误报
    pollTimer = setTimeout(() => pollStatus(runId, htmlUrl), POLL_INTERVAL_MS * 2);
    showResult('loading', `获取进度失败，稍后重试：${err.message}`);
  }
}

function startTracking(runId, htmlUrl) {
  stopPolling();
  pollStartedAt = Date.now();
  progressDiv.classList.add('visible');
  stepList.innerHTML = '';
  setBadge('queued', '排队中');
  progressTitle.textContent = '同步进度';
  if (htmlUrl) {
    runLink.href = htmlUrl;
  }
  runLink.style.display = htmlUrl ? 'inline-block' : 'none';
  showResult('loading', '已触发同步，正在获取进度…');
  pollStatus(runId, htmlUrl);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  stopPolling();

  const source = sourceInput.value.trim();
  const destination = destinationInput.value.trim();
  const tags = tagsInput.value.trim();

  if (!source) {
    showResult('error', '请输入源镜像地址');
    sourceInput.focus();
    return;
  }
  if (!destination) {
    showResult('error', '请输入目标镜像地址');
    destinationInput.focus();
    return;
  }
  if (!destination.includes('swr.')) {
    showResult('error', '目标仓库仅支持华为云 SWR（地址需包含 swr. 域名）');
    destinationInput.focus();
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
      body: JSON.stringify({ source, destination, tags }),
    });

    const data = await response.json();

    if (response.ok && data.ok) {
      if (data.run_id) {
        startTracking(data.run_id, data.html_url);
        return;
      }
      // 触发成功但未拿到 run_id
      submitBtn.disabled = false;
      submitBtn.textContent = '开始同步';
      showResult('success', '✅ 已触发同步任务，请前往 GitHub Actions 页面查看执行进度。');
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
