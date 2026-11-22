/**
 * 前端逻辑 — 容器镜像同步
 *
 * 需要访问口令登录；登录后令牌存 localStorage，所有 API 带 Authorization 头。
 * 只需填源镜像地址：目标路径由 Worker 按 SWR_REGISTRY + 组织自动推导。
 * 注意：前端代码中不得出现任何 GitHub Token 或 SWR 凭证。
 */

const IS_FILE_PROTOCOL = location.protocol === 'file:';
const PROXY_URL = (typeof window.PROXY_URL === 'string' ? window.PROXY_URL : '').replace(/\/$/, '');
const OPEN_HINT = '请通过服务地址打开页面（如 http://192.168.148.4:8787），不要直接双击本地 html 文件';

const POLL_INTERVAL_MS = 8000;
const POLL_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TAG = 'latest';

// Worker 不可达时用于展示预览
const FALLBACK_REGISTRY = 'swr.cn-east-4.myhuaweicloud.com';
const FALLBACK_ORG = 'ascend-sync';

const AUTH_KEY = 'imageSync.auth.v1';
const LAST_RUN_KEY = 'imageSync.lastRun.v1';
const HISTORY_KEY = 'imageSync.history.v1';
const HISTORY_LIMIT = 10;
const LAST_RUN_TTL_MS = 24 * 60 * 60 * 1000;

// DOM
const loginView = document.getElementById('loginView');
const appView = document.getElementById('appView');
const loginForm = document.getElementById('loginForm');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const loginMsg = document.getElementById('loginMsg');
const logoutBtn = document.getElementById('logoutBtn');

const form = document.getElementById('syncForm');
const sourceInput = document.getElementById('source');
const orgInput = document.getElementById('org');
const archSelect = document.getElementById('arch');
const submitBtn = document.getElementById('submitBtn');
const resultDiv = document.getElementById('result');
const previewTarget = document.getElementById('previewTarget');
const copyBtn = document.getElementById('copyBtn');
const progressDiv = document.getElementById('progress');
const statusBadge = document.getElementById('statusBadge');
const stepList = document.getElementById('stepList');
const runLink = document.getElementById('runLink');
const progressTitle = document.getElementById('progressTitle');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const historyHint = document.getElementById('historyHint');
const historySearch = document.getElementById('historySearch');
const refreshHistoryBtn = document.getElementById('refreshHistory');

let scrollInfo = { registry: FALLBACK_REGISTRY, defaultOrg: FALLBACK_ORG };
let pollTimer = null;
let pollStartedAt = 0;

/* ---------------- 登录态 ---------------- */

function getToken() {
  try {
    return localStorage.getItem(AUTH_KEY) || '';
  } catch {
    return '';
  }
}

function setToken(token) {
  try {
    localStorage.setItem(AUTH_KEY, token);
  } catch { /* ignore */ }
}

function clearToken() {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch { /* ignore */ }
}

function setLoginMsg(message) {
  loginMsg.textContent = message || '';
}

function showLogin(message) {
  appView.classList.remove('visible');
  loginView.style.display = 'block';
  setLoginMsg(message || '');
  if (!IS_FILE_PROTOCOL) passwordInput.focus();
}

function showApp() {
  loginView.style.display = 'none';
  appView.classList.add('visible');
  renderPreview();
}

/** 统一带上登录令牌的 fetch */
function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${PROXY_URL}${path}`, { ...options, headers });
}

/** 登录失效处理 */
function handleUnauthorized(message) {
  clearToken();
  stopPolling();
  showLogin(message || '登录已过期，请重新登录');
}

/* ---------------- 本地持久化 ---------------- */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 忽略配额/隐私模式异常 */ }
}

function loadLastRun() {
  const v = readJSON(LAST_RUN_KEY, null);
  if (!v || !v.runId) return null;
  if (!v.startedAt || Date.now() - v.startedAt > LAST_RUN_TTL_MS) {
    try { localStorage.removeItem(LAST_RUN_KEY); } catch { /* ignore */ }
    return null;
  }
  return v;
}

function saveLastRun(v) {
  writeJSON(LAST_RUN_KEY, v);
}

function loadHistory() {
  const v = readJSON(HISTORY_KEY, []);
  return Array.isArray(v) ? v : [];
}

function saveHistory(list) {
  writeJSON(HISTORY_KEY, list.slice(0, HISTORY_LIMIT));
}

function upsertHistory(entry) {
  const list = loadHistory();
  const idx = list.findIndex((e) => e.runId === entry.runId);
  if (idx === -1) list.unshift(entry);
  else list[idx] = { ...list[idx], ...entry };
  saveHistory(list);
}

/* ---------------- 渲染 ---------------- */

function showResult(type, message) {
  resultDiv.className = type;
  resultDiv.textContent = message;
}

function setBadge(kind, text) {
  statusBadge.className = `badge ${kind}`;
  statusBadge.textContent = text;
}

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
  if (copyBtn) copyBtn.disabled = !parsed;
  if (!parsed) {
    previewTarget.textContent = '填写源镜像地址后自动生成';
    return;
  }
  const org = (orgInput.value || '').trim() || scrollInfo.defaultOrg;
  const tag = parsed.tag || DEFAULT_TAG;
  previewTarget.textContent = `${scrollInfo.registry}/${org}/${parsed.repo}:${tag}`;
}

const STEP_ICONS = {
  success: '✅',
  failure: '❌',
  cancelled: '⚪',
  skipped: '⏭️',
  in_progress: '🔄',
  queued: '⏳',
};

const HISTORY_ICONS = {
  success: '✅',
  failure: '❌',
  cancelled: '⚪',
  skipped: '⏭️',
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

function fmtTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function statusWord(conclusion) {
  if (conclusion === 'success') return '成功';
  if (conclusion === 'failure') return '失败';
  if (conclusion === 'cancelled') return '已取消';
  if (conclusion === 'skipped') return '已跳过';
  return '进行中';
}

let historyMode = 'local'; // 'global' 读 GitHub 运行记录；'local' 回退到本地缓存
let globalRuns = [];

function buildHistoryItem({ icon, source, destination, text, meta, url, copyText }) {
  const li = document.createElement('li');
  li.className = 'hist-item';

  const iconEl = document.createElement('span');
  iconEl.className = 'hist-icon';
  iconEl.textContent = icon;

  const body = document.createElement('div');
  body.className = 'hist-body';

  const title = document.createElement('div');
  title.className = 'hist-title';
  if (source && destination) {
    const src = document.createElement('div');
    src.className = 'hist-src';
    src.textContent = source;

    const arrow = document.createElement('div');
    arrow.className = 'hist-arrow';
    arrow.textContent = '↓';

    const dst = document.createElement('div');
    dst.className = 'hist-dst';
    dst.textContent = destination;

    title.append(src, arrow, dst);
    title.title = `${source} → ${destination}`;
  } else {
    title.textContent = text;
    title.title = text;
  }

  const metaEl = document.createElement('div');
  metaEl.className = 'hist-meta';
  metaEl.textContent = meta;

  const actions = document.createElement('div');
  actions.className = 'hist-actions';

  if (copyText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-btn';
    btn.textContent = '复制';
    btn.title = `复制：${copyText}`;
    btn.addEventListener('click', async () => {
      try {
        const ok = await writeClipboard(copyText);
        if (!ok) return;
        btn.textContent = '已复制 ✓';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '复制';
          btn.classList.remove('copied');
        }, 1500);
      } catch { /* ignore */ }
    });
    actions.appendChild(btn);
  }

  if (url) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '日志 →';
    actions.appendChild(a);
  }

  body.append(title, metaEl);
  if (actions.childNodes.length) body.appendChild(actions);
  li.append(iconEl, body);

  return li;
}

/** 从 run 标题（Sync <源> → <目标>）解析出源与目标 */
function parseRunTitle(title) {
  const raw = String(title || '').trim();
  const body = raw.replace(/^Sync\s+/i, '');
  const idx = body.indexOf('→');
  if (idx === -1) return { source: '', destination: '', text: raw };
  return {
    source: body.slice(0, idx).trim(),
    destination: body.slice(idx + 1).trim(),
    text: raw,
  };
}

function dayBucket(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '更早';
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  return '更早';
}

function updateHistoryHint(count) {
  if (!historyHint) return;
  const show = count < 3;
  historyHint.classList.toggle('visible', show);
  if (historyList) historyList.style.flex = show ? '0 1 auto' : '1 1 auto';
}

function renderHistory() {
  const isGlobal = historyMode === 'global';
  const all = isGlobal ? globalRuns : loadHistory();
  const query = (historySearch && historySearch.value ? historySearch.value : '').trim().toLowerCase();

  const countEl = document.getElementById('historyCount');
  if (countEl) countEl.textContent = String(all.length);

  const normalized = all.map((entry) => {
    if (isGlobal) {
      const parsed = parseRunTitle(entry.title);
      return {
        icon: HISTORY_ICONS[entry.conclusion] || '🔄',
        source: parsed.source,
        destination: parsed.destination,
        text: parsed.text || `运行 #${entry.id}`,
        meta: `${statusWord(entry.conclusion)} · ${fmtTime(entry.created_at)}`,
        ts: entry.created_at,
        url: entry.html_url,
        copyText: parsed.destination,
        search: `${parsed.text} ${statusWord(entry.conclusion)} ${entry.id}`.toLowerCase(),
      };
    }
    const label = entry.destination || entry.source || '未知镜像';
    return {
      icon: HISTORY_ICONS[entry.conclusion] || '🔄',
      source: entry.source || '',
      destination: entry.destination || '',
      text: label,
      meta: `${entry.arch ? `${entry.arch} · ` : ''}${statusWord(entry.conclusion)} · ${fmtTime(entry.startedAt)}`,
      ts: entry.startedAt,
      url: entry.htmlUrl,
      copyText: entry.destination || '',
      search: `${entry.source || ''} ${entry.destination || ''} ${entry.arch || ''} ${statusWord(entry.conclusion)}`.toLowerCase(),
    };
  });

  historyList.innerHTML = '';

  if (!all.length) {
    historyEmpty.style.display = 'none';
    updateHistoryHint(0);
    return;
  }

  const entries = query ? normalized.filter((e) => e.search.includes(query)) : normalized;

  if (!entries.length) {
    historyEmpty.textContent = '没有匹配的记录';
    historyEmpty.style.display = 'block';
    if (historyHint) historyHint.classList.remove('visible');
    if (historyList) historyList.style.flex = '1 1 auto';
    return;
  }

  historyEmpty.style.display = 'none';

  let lastDay = '';
  entries.forEach((entry) => {
    const day = dayBucket(entry.ts);
    if (day !== lastDay) {
      lastDay = day;
      const header = document.createElement('li');
      header.className = 'hist-day';
      header.textContent = day;
      historyList.appendChild(header);
    }
    historyList.appendChild(buildHistoryItem(entry));
  });

  updateHistoryHint(query ? 0 : all.length);
}

/** 拉取全局运行记录（失败则回退本地缓存） */
async function refreshHistory() {
  if (!getToken()) {
    historyMode = 'local';
    renderHistory();
    return;
  }
  try {
    const resp = await apiFetch('/api/runs?limit=15');
    if (resp.status === 401) return;
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'bad response');
    globalRuns = data.runs || [];
    historyMode = 'global';
  } catch {
    historyMode = 'local';
  }
  renderHistory();
}

/* ---------------- 配置 / 进度 ---------------- */

async function loadConfig() {
  try {
    const resp = await apiFetch('/api/config');
    if (resp.status === 401) {
      handleUnauthorized('登录已过期，请重新登录');
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data && data.ok) {
      scrollInfo.registry = data.registry || FALLBACK_REGISTRY;
      scrollInfo.defaultOrg = data.default_org || FALLBACK_ORG;
      if (!orgInput.value.trim()) orgInput.value = scrollInfo.defaultOrg;
      if (data.default_arch && archSelect) archSelect.value = data.default_arch;
      renderPreview();
    }
  } catch (err) {
    renderPreview();
    showResult('error', `❌ 无法连接同步服务（${PROXY_URL || location.origin}）：${err.message}`);
  }
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
    const resp = await apiFetch(`/api/status?id=${encodeURIComponent(runId)}`);

    if (resp.status === 401) {
      handleUnauthorized('登录已过期，请重新登录');
      return;
    }

    const data = await resp.json();

    if (resp.status === 404) {
      stopPolling();
      try { localStorage.removeItem(LAST_RUN_KEY); } catch { /* ignore */ }
      progressDiv.classList.remove('visible');
      showResult('error', '找不到这次运行记录（可能已被 GitHub 清理），请重新触发同步。');
      return;
    }
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

      upsertHistory({
        runId,
        destination,
        htmlUrl: data.html_url || htmlUrl,
        conclusion: data.conclusion,
        finishedAt: Date.now(),
      });
      refreshHistory();
      const savedRun = loadLastRun();
      if (savedRun && savedRun.runId === runId) {
        saveLastRun({ ...savedRun, conclusion: data.conclusion, htmlUrl: data.html_url || htmlUrl });
      }

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

/** 刷新后恢复上次同步的进度 */
async function restoreLastRun() {
  const last = loadLastRun();
  if (!last) return;

  progressDiv.classList.add('visible');
  stepList.innerHTML = '';
  setBadge('queued', '查询中…');
  progressTitle.textContent = '上次同步';
  if (last.htmlUrl) {
    runLink.href = last.htmlUrl;
    runLink.style.display = 'inline-block';
  }
  if (last.destination) {
    showResult('loading', `上次同步：${last.destination}`);
  }

  pollStartedAt = Date.now();
  pollStatus(last.runId, last.htmlUrl, last.destination);
}

/* ---------------- 事件 ---------------- */

sourceInput.addEventListener('input', renderPreview);
orgInput.addEventListener('input', renderPreview);

/* ---------------- 复制镜像地址 ---------------- */

let copyResetTimer = null;

function currentTargetText() {
  const text = (previewTarget.textContent || '').trim();
  // 还没有生成真实地址时（占位文案）不复制
  return text.startsWith('填写') ? '' : text;
}

async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // 非安全上下文（http）回退方案
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

if (copyBtn) {
  copyBtn.addEventListener('click', async () => {
    const text = currentTargetText();
    if (!text) {
      showResult('error', '请先填写源镜像地址');
      sourceInput.focus();
      return;
    }

    try {
      const ok = await writeClipboard(text);
      if (!ok) {
        showResult('error', `复制失败，请手动选中复制：${text}`);
        return;
      }
      copyBtn.textContent = '已复制 ✓';
      copyBtn.classList.add('copied');
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copyBtn.textContent = '复制';
        copyBtn.classList.remove('copied');
      }, 1500);
    } catch (err) {
      showResult('error', `复制失败：${err.message}`);
    }
  });
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (IS_FILE_PROTOCOL) {
    setLoginMsg(OPEN_HINT);
    return;
  }

  const password = passwordInput.value;
  if (!password) {
    setLoginMsg('请输入访问口令');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = '登录中…';
  setLoginMsg('');

  try {
    const resp = await fetch(`${PROXY_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await resp.json();

    if (resp.ok && data.ok && data.token) {
      setToken(data.token);
      passwordInput.value = '';
      showApp();
      await loadConfig();
      refreshHistory();
      restoreLastRun();
    } else {
      setLoginMsg(data.error || `登录失败 (HTTP ${resp.status})`);
    }
  } catch (err) {
    setLoginMsg(`网络错误（${PROXY_URL || location.origin}）：${err.message}`);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = '登录';
  }
});

logoutBtn.addEventListener('click', () => {
  clearToken();
  stopPolling();
  progressDiv.classList.remove('visible');
  showResult('error', '已退出登录。');
  showLogin('已退出登录');
});

if (historySearch) {
  historySearch.addEventListener('input', renderHistory);
}

if (refreshHistoryBtn) {
  refreshHistoryBtn.addEventListener('click', () => {
    refreshHistoryBtn.disabled = true;
    refreshHistoryBtn.textContent = '刷新中…';
    refreshHistory().finally(() => {
      refreshHistoryBtn.disabled = false;
      refreshHistoryBtn.textContent = '刷新';
    });
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  stopPolling();

  if (IS_FILE_PROTOCOL) {
    showResult('error', `❌ 无法触发同步：${OPEN_HINT}`);
    return;
  }

  const source = sourceInput.value.trim();
  const org = orgInput.value.trim();
  const arch = archSelect.value || 'amd64';

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
    const response = await apiFetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, org, arch }),
    });

    if (response.status === 401) {
      handleUnauthorized('登录已过期，请重新登录');
      submitBtn.disabled = false;
      submitBtn.textContent = '开始同步';
      return;
    }

    const data = await response.json();

    if (response.ok && data.ok) {
      progressDiv.classList.add('visible');
      if (data.run_id) {
        const record = {
          runId: data.run_id,
          source,
          arch,
          destination: data.destination || '',
          startedAt: Date.now(),
          htmlUrl: data.html_url || '',
          conclusion: null,
        };
        saveLastRun(record);
        upsertHistory(record);
        startTracking(data.run_id, data.html_url, data.destination);
        // 新 run 出现在全局列表里通常有几秒延迟
        setTimeout(() => refreshHistory(), 6000);
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
    showResult('error', `❌ 网络错误（请求 ${PROXY_URL || location.origin}/api/sync）：${err.message}`);
    submitBtn.disabled = false;
    submitBtn.textContent = '开始同步';
  }
});

/* ---------------- 初始化 ---------------- */

async function boot() {
  renderHistory();

  if (IS_FILE_PROTOCOL) {
    showLogin(OPEN_HINT);
    return;
  }

  const token = getToken();
  if (token) {
    try {
      const resp = await apiFetch('/api/session');
      if (resp.ok) {
        showApp();
        await loadConfig();
        refreshHistory();
        restoreLastRun();
        return;
      }
    } catch { /* 网络异常则回到登录 */ }
    clearToken();
  }

  showLogin();
}

boot();
