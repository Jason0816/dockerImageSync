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
const themeSwitch = document.getElementById('themeSwitch');

const form = document.getElementById('syncForm');
const sourceInput = document.getElementById('source');
const orgInput = document.getElementById('org');
const orgLockBtn = document.getElementById('orgLock');
const orgHint = document.getElementById('orgHint');
const archChips = document.getElementById('archChips');
const archError = document.getElementById('archError');
const previewArch = document.getElementById('previewArch');
const sourceResolveHint = document.getElementById('sourceResolveHint');
const resolveTarget = document.getElementById('resolveTarget');
const resolveToggle = document.getElementById('resolveToggle');
const resolveDetail = document.getElementById('resolveDetail');
const isPublicInput = document.getElementById('isPublic');
const submitBtn = document.getElementById('submitBtn');
const resultDiv = document.getElementById('result');
const previewTarget = document.getElementById('previewTarget');
const copyBtn = document.getElementById('copyBtn');
const progressDiv = document.getElementById('progressDrawer');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const drawerClose = document.getElementById('drawerClose');
const progressBar = document.getElementById('progressBar');
const progressBarText = document.getElementById('progressBarText');
const progressBarBtn = document.getElementById('progressBarBtn');
const statusBadge = document.getElementById('statusBadge');
const stepList = document.getElementById('stepList');
const runLink = document.getElementById('runLink');
const progressTitle = document.getElementById('progressTitle');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const historyHint = document.getElementById('historyHint');
const historySearch = document.getElementById('historySearch');
const refreshHistoryBtn = document.getElementById('refreshHistory');
const adminToggleBtn = document.getElementById('adminToggle');
const bulkBar = document.getElementById('bulkBar');
const selectAllBox = document.getElementById('selectAll');
const bulkCountEl = document.getElementById('bulkCount');
const bulkDeleteBtn = document.getElementById('bulkDelete');
const showDeletedBox = document.getElementById('showDeleted');
const searchNote = document.getElementById('searchNote');

let scrollInfo = { registry: FALLBACK_REGISTRY, defaultOrg: FALLBACK_ORG };
let pollTimer = null;
let pollStartedAt = 0;
let trackingActive = false;

/* ---------------- 主题（亮 / 暗 / 跟随系统） ---------------- */

const THEME_KEY = 'imageSync.theme';
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

function getThemeMode() {
  try {
    return localStorage.getItem(THEME_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

function applyTheme(mode) {
  const resolved = mode === 'auto' ? (themeMedia.matches ? 'dark' : 'light') : mode;
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;

  if (themeSwitch) {
    themeSwitch.querySelectorAll('button[data-mode]').forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
}

function setThemeMode(mode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch { /* ignore */ }
  applyTheme(mode);
}

if (themeSwitch) {
  themeSwitch.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (btn) setThemeMode(btn.dataset.mode);
  });
}

themeMedia.addEventListener('change', () => {
  if (getThemeMode() === 'auto') applyTheme('auto');
});

applyTheme(getThemeMode());

/* ---------------- 目标组织锁定 ---------------- */

let orgLocked = true;

function setOrgLocked(locked) {
  orgLocked = locked;

  if (orgInput) orgInput.readOnly = locked;

  if (orgLockBtn) {
    orgLockBtn.setAttribute('aria-pressed', String(locked));
    orgLockBtn.title = locked ? '点击解锁以修改' : '点击锁定';
    orgLockBtn.setAttribute('aria-label', locked ? '解锁组织名' : '锁定组织名');
  }

  if (orgHint) {
    orgHint.textContent = locked
      ? 'SWR 组织名，默认 ascend-sync；已锁定，解锁后可修改'
      : '已解锁：可直接修改组织名，改完建议重新锁定';
  }

  if (!locked && orgInput) {
    orgInput.focus();
    orgInput.select();
  }
}

if (orgLockBtn) {
  orgLockBtn.addEventListener('click', () => setOrgLocked(!orgLocked));
}

setOrgLocked(true);

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
  document.body.classList.remove('app-mode');
  loginView.style.display = 'block';
  setLoginMsg(message || '');
  if (!IS_FILE_PROTOCOL) passwordInput.focus();
}

function showApp() {
  loginView.style.display = 'none';
  appView.classList.add('visible');
  document.body.classList.add('app-mode');
  renderPreview();
}

/* ---------------- 进度抽屉 ---------------- */

function drawerIsOpen() {
  return Boolean(progressDiv && progressDiv.classList.contains('open'));
}

function openDrawer() {
  if (!progressDiv) return;
  progressDiv.classList.add('open');
  progressDiv.setAttribute('aria-hidden', 'false');
  if (drawerBackdrop) drawerBackdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  hideBar();
}

function closeDrawer() {
  if (!progressDiv) return;
  progressDiv.classList.remove('open');
  progressDiv.setAttribute('aria-hidden', 'true');
  if (drawerBackdrop) drawerBackdrop.classList.remove('open');
  document.body.style.overflow = '';
  if (trackingActive) showBar('正在同步…');
}

function showBar(text) {
  if (!progressBar) return;
  if (progressBarText) progressBarText.textContent = text || '正在同步…';
  progressBar.classList.add('visible');
}

function hideBar() {
  if (progressBar) progressBar.classList.remove('visible');
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
  trackingActive = false;
  closeDrawer();
  hideBar();
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

function clearResult() {
  resultDiv.className = '';
  resultDiv.textContent = '';
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

const ARCH_LABELS = {
  amd64: 'amd64',
  arm64: 'arm64',
  'amd64+arm64': 'amd64+arm64',
  all: 'amd64+arm64',
};

/** 当前选中的架构，未选返回 '' */
function selectedArch() {
  const checked = document.querySelector('input[name="arch"]:checked');
  return checked ? checked.value : '';
}

function setArch(value) {
  document.querySelectorAll('input[name="arch"]').forEach((input) => {
    input.checked = input.value === value;
  });
}

function clearArchError() {
  if (archChips) archChips.classList.remove('invalid');
  if (archError) archError.classList.remove('visible');
}

function showArchError() {
  if (archChips) {
    archChips.classList.add('invalid');
    // 重新触发动画
    archChips.classList.remove('invalid');
    void archChips.offsetWidth;
    archChips.classList.add('invalid');
    archChips.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (archError) archError.classList.add('visible');
  const first = document.querySelector('input[name="arch"]');
  if (first) first.focus({ preventScroll: true });
}

/**
 * 按 Docker 规则补全省略的 registry，返回 { resolved, implicit }。
 * implicit 为 true 表示用户没写 registry，会被当成 Docker Hub 镜像。
 */
function resolveSource(source) {
  const raw = String(source || '').trim();
  if (!raw) return null;

  let s = raw.split('@')[0];
  const slash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  let tag = '';
  if (colon > slash) {
    tag = s.slice(colon + 1);
    s = s.slice(0, colon);
  }

  const parts = s.split('/').filter(Boolean);
  if (!parts.length) return null;

  const first = parts[0];
  // 只有当存在多个路径段时，首段才可能是 registry；
  // 单段名字里即便带点（如 8.3.rc1-xxx）也是镜像名，不是 registry。
  const hasRegistry = parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const implicit = !hasRegistry;
  let resolved;
  if (hasRegistry) resolved = parts.join('/');
  else if (parts.length === 1) resolved = `docker.io/library/${parts[0]}`;
  else resolved = `docker.io/${parts.join('/')}`;

  return { resolved: resolved + (tag ? `:${tag}` : ''), implicit, repo: parts[parts.length - 1], tag };
}

/** 源地址缺失 registry 时给出非阻断提示：只显示一行解析结果，详情可展开 */
function renderSourceHint() {
  if (!sourceResolveHint) return;
  const info = resolveSource(sourceInput.value);
  const show = Boolean(info && info.implicit && sourceInput.value.trim());

  sourceResolveHint.hidden = !show;
  if (!show) {
    if (resolveDetail) resolveDetail.hidden = true;
    if (resolveToggle) {
      resolveToggle.setAttribute('aria-expanded', 'false');
      resolveToggle.textContent = '详情';
    }
    return;
  }

  if (resolveTarget) {
    resolveTarget.textContent = info.resolved;
    resolveTarget.title = info.resolved;
  }
  sourceResolveHint.title = `实际会拉取：${info.resolved}`;
}

function renderPreview() {
  const parsed = parseImage(sourceInput.value);
  const arch = selectedArch();

  renderSourceHint();

  if (copyBtn) copyBtn.disabled = !parsed;

  if (previewArch) {
    // 只有目标地址有效时才显示架构徽章，避免和占位文案并列产生噪音
    if (arch && parsed) {
      previewArch.textContent = ARCH_LABELS[arch] || arch;
      previewArch.hidden = false;
    } else {
      previewArch.hidden = true;
    }
  }

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

/**
 * 元信息行的时间：当天/昨天只显示时钟（分组标题已表达日期），
 * 更早的记录补上 MM-DD，避免看不出是哪天。
 */
function fmtClock(ts, bucket) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (bucket === '更早') {
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${mo}-${day} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

/** 秒 → 人类可读耗时：45s / 3m20s / 1h02m */
function fmtDuration(seconds, status) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '';
  const total = Math.max(0, Math.round(Number(seconds)));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m${s > 0 ? String(s).padStart(2, '0') + 's' : ''}`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = status === 'in_progress' ? '+' : '';
  return `${h}h${String(mm).padStart(2, '0')}m${suffix}`;
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
let historyLoading = false; // 首次拉取全局记录期间的加载态
let role = 'user';          // 登录角色：user / admin
let adminEnabled = false;   // 服务端是否配置了管理员口令
let adminMode = false;      // 前端是否处于管理模式（显示选择框）
let showDeleted = false;    // 管理员：搜索结果是否包含已删除记录
const selectedRunIds = new Set();

// 搜索（走 D1 索引）
let searchResults = null;   // null = 未搜索；数组 = 搜索结果
let searchTotal = 0;
let searchTimer = null;
let searchSeq = 0;

// 全局记录的会话级快照：刷新时先渲染它，再后台校验更新（stale-while-revalidate）
const RUNS_CACHE_KEY = 'imageSync.runsCache.v1';
const RUNS_CACHE_TTL_MS = 10 * 60 * 1000;

function readRunsCache() {
  try {
    const raw = sessionStorage.getItem(RUNS_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.runs) || !data.runs.length) return null;
    if (!data.fetchedAt || Date.now() - data.fetchedAt > RUNS_CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeRunsCache(runs) {
  try {
    sessionStorage.setItem(RUNS_CACHE_KEY, JSON.stringify({ runs, fetchedAt: Date.now() }));
  } catch { /* 隐私模式或配额不足时忽略 */ }
}

/** 按路径分隔符插入换行机会，避免把仓库名从中间劈开 */
function appendWrapped(el, text) {
  const parts = String(text || '').split('/');
  parts.forEach((part, index) => {
    if (part) el.appendChild(document.createTextNode(part));
    if (index < parts.length - 1) {
      el.appendChild(document.createTextNode('/'));
      el.appendChild(document.createElement('wbr'));
    }
  });
}

/** 目标地址去掉 registry 前缀，只保留 org/repo:tag（复制时仍用完整地址） */
function shortDest(destination) {
  const d = String(destination || '').trim();
  if (!d) return '';
  const parts = d.split('/');
  const first = parts[0] || '';
  const looksLikeRegistry = first.includes('.') || first.includes(':');
  if (parts.length >= 3 && looksLikeRegistry) return parts.slice(1).join('/');
  return d;
}

/** 状态图标：用 SVG 代替 emoji，跨平台渲染一致 */
const STATUS_SVG = {
  success: '<circle cx="8" cy="8" r="6.4"/><path d="M4.9 8.2l2.2 2.2 4-4.2"/>',
  failure: '<circle cx="8" cy="8" r="6.4"/><path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6"/>',
  cancelled: '<circle cx="8" cy="8" r="6.4"/><path d="M5.2 8h5.6"/>',
  running: '<circle cx="8" cy="8" r="6.4" opacity="0.3"/><path class="arc" d="M8 1.6a6.4 6.4 0 016.4 6.4"/>',
};

function statusKind(conclusion, status) {
  if (status === 'unknown') return 'cancelled';
  if (status && status !== 'completed') return 'running';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'failure') return 'failure';
  if (conclusion === 'cancelled' || conclusion === 'skipped') return 'cancelled';
  return 'running';
}

/**
 * 元信息行里的状态文字。
 * 成功/失败由左侧彩色图标表达，不再重复文字；
 * 已取消 / 已跳过 / 进行中 / 状态未知 文字仍有必要（灰色图标无法区分这几态）。
 */
function metaStatusText(conclusion, status) {
  if (status === 'unknown') return '状态未知';
  if (status && status !== 'completed') return status === 'queued' ? '排队中' : '进行中';
  if (conclusion === 'cancelled') return '已取消';
  if (conclusion === 'skipped') return '已跳过';
  return '';
}

function createStatusIcon(conclusion, status) {
  const kind = statusKind(conclusion, status);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `hist-svg hist-svg--${kind}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', statusWord(conclusion));
  svg.innerHTML = STATUS_SVG[kind];
  return svg;
}

/** 左栏只放状态图标；架构与耗时移到元信息行右侧 */
function buildHistoryItem({ runId, conclusion, status, source, destination, text, meta, url, copyText, arch, duration, deleted }) {
  const li = document.createElement('li');
  li.className = deleted ? 'hist-item hist-item--deleted' : 'hist-item';

  // 管理员模式：勾选框
  if (adminMode && runId) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'hist-select';
    box.dataset.runId = String(runId);
    box.checked = selectedRunIds.has(Number(runId));
    if (deleted) box.disabled = true;
    box.title = '选择此记录';
    box.addEventListener('change', () => {
      const id = Number(runId);
      if (box.checked) selectedRunIds.add(id);
      else selectedRunIds.delete(id);
      updateBulkCount();
    });
    li.appendChild(box);
  }

  const rail = document.createElement('div');
  rail.className = 'hist-rail';
  rail.appendChild(createStatusIcon(conclusion, status));

  const body = document.createElement('div');
  body.className = 'hist-body';

  const title = document.createElement('div');
  title.className = 'hist-title';
  if (source && destination) {
    const src = document.createElement('div');
    src.className = 'hist-src';
    appendWrapped(src, source);

    const dst = document.createElement('div');
    dst.className = 'hist-dst';
    // 箭头内联到目标行首；文字放进独立 span，换行时能对齐到箭头右侧
    const arrow = document.createElement('span');
    arrow.className = 'hist-arrow';
    arrow.textContent = '→';
    const dstText = document.createElement('span');
    dstText.className = 'hist-dst-text';
    appendWrapped(dstText, shortDest(destination));
    dst.append(arrow, dstText);

    title.append(src, dst);
    title.title = `${source} → ${destination}`;
  } else {
    title.textContent = text;
    title.title = text;
  }

  const metaEl = document.createElement('div');
  metaEl.className = 'hist-meta';

  const metaText = document.createElement('span');
  metaText.className = 'hist-meta-text';
  if (deleted) {
    const tag = document.createElement('span');
    tag.className = 'hist-tag-del';
    tag.textContent = '已删除';
    tag.title = '已从 Actions 删除，仅保留在索引中';
    metaEl.appendChild(tag);
  }
  metaText.textContent = meta;
  metaEl.appendChild(metaText);

  const archLabel = arch ? (ARCH_LABELS[arch] || arch) : '';
  if (duration || archLabel) {
    const dataEl = document.createElement('span');
    dataEl.className = 'hist-data';
    if (duration) {
      const durEl = document.createElement('span');
      durEl.className = 'hist-dur';
      durEl.textContent = duration;
      durEl.title = `耗时 ${duration}`;
      dataEl.appendChild(durEl);
    }
    if (archLabel) {
      const archEl = document.createElement('span');
      archEl.className = 'hist-arch';
      archEl.textContent = archLabel;
      archEl.title = `目标架构：${archLabel}`;
      dataEl.appendChild(archEl);
    }
    metaEl.appendChild(dataEl);
  }

  // 管理员模式：删除按钮放在元信息行最右，与数据列对齐
  if (adminMode && runId && !deleted) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'hist-del';
    del.textContent = '✕';
    del.title = '删除这条记录';
    del.addEventListener('click', () => deleteRuns([Number(runId)]));
    metaEl.appendChild(del);
  }

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
  li.append(rail, body);

  return li;
}

/** 从 run 标题（Sync <源> → <目标> [<架构>]）解析出源、目标与架构 */
function parseRunTitle(title) {
  const raw = String(title || '').trim();
  const body = raw.replace(/^Sync\s+/i, '');

  // 末尾的 [amd64] / [arm64] / [all] 是工作流写入的架构标记
  let arch = '';
  const archMatch = body.match(/\s*\[(amd64\+arm64|amd64|arm64|all)\]\s*$/i);
  let trimmed = body;
  if (archMatch) {
    arch = archMatch[1].toLowerCase();
    trimmed = body.slice(0, archMatch.index).trim();
  }

  const idx = trimmed.indexOf('→');
  if (idx === -1) return { source: '', destination: '', arch, text: raw };
  return {
    source: trimmed.slice(0, idx).trim(),
    destination: trimmed.slice(idx + 1).trim(),
    arch,
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
  const countEl = document.getElementById('historyCount');

  // 首次拉取全局记录时先显示加载态，避免先闪一版本地缓存
  if (historyLoading) {
    if (countEl) countEl.textContent = '…';
    historyList.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'hist-loading';
    li.textContent = '正在加载最近同步…';
    historyList.appendChild(li);
    if (historyEmpty) historyEmpty.style.display = 'none';
    if (historyHint) historyHint.classList.remove('visible');
    return;
  }

  const isSearch = Array.isArray(searchResults);
  const isGlobal = historyMode === 'global';
  const all = isSearch ? searchResults : (isGlobal ? globalRuns : loadHistory());
  const query = (historySearch && historySearch.value ? historySearch.value : '').trim().toLowerCase();

  if (countEl) countEl.textContent = String(all.length);

  if (searchNote) {
    if (isSearch) {
      searchNote.textContent = `索引匹配 ${searchTotal} 条${searchTotal > all.length ? `，显示最新 ${all.length} 条` : ''}（含已从 Actions 清理的记录）`;
      searchNote.hidden = false;
    } else {
      searchNote.hidden = true;
    }
  }

  const normalized = all.map((entry) => {
    // 搜索结果是 D1 行：字段直接可用，没有 status 字段
    if (isSearch) {
      const effStatus = entry.conclusion ? 'completed' : 'in_progress';
      return {
        runId: entry.id,
        conclusion: entry.conclusion,
        status: effStatus,
        deleted: Boolean(entry.deleted_at),
        source: entry.source,
        destination: entry.destination,
        arch: entry.arch,
        duration: fmtDuration(entry.duration_seconds, effStatus),
        text: entry.title || `运行 #${entry.id}`,
        meta: [metaStatusText(entry.conclusion, effStatus),
          fmtClock(entry.created_at, dayBucket(entry.created_at))].filter(Boolean).join(' · '),
        ts: entry.created_at,
        url: entry.html_url,
        copyText: entry.destination,
        search: `${entry.source} ${entry.destination} ${entry.arch || ''}`.toLowerCase(),
      };
    }
    if (isGlobal) {
      const parsed = parseRunTitle(entry.title);
      const dur = fmtDuration(entry.duration_seconds, entry.status);
      return {
        runId: entry.id,
        conclusion: entry.conclusion,
        status: entry.status,
        source: parsed.source,
        destination: parsed.destination,
        arch: parsed.arch,
        duration: dur,
        text: parsed.text || `运行 #${entry.id}`,
        meta: [metaStatusText(entry.conclusion, entry.status), fmtClock(entry.created_at, dayBucket(entry.created_at))]
          .filter(Boolean).join(' · '),
        ts: entry.created_at,
        url: entry.html_url,
        copyText: parsed.destination,
        search: `${parsed.text} ${parsed.arch} ${statusWord(entry.conclusion)} ${entry.id}`.toLowerCase(),
      };
    }
    const label = entry.destination || entry.source || '未知镜像';
    // 本地缓存的历史：用 startedAt / finishedAt 计算
    const localDur = entry.finishedAt && entry.startedAt
      ? Math.round((entry.finishedAt - entry.startedAt) / 1000)
      : null;
    // 关闭页面导致没拿到结束状态的条目：超过 30 分钟就不再声称「进行中」
    const stale = !entry.conclusion && entry.startedAt &&
      (Date.now() - entry.startedAt > 30 * 60 * 1000);
    const effStatus = entry.conclusion ? 'completed' : (stale ? 'unknown' : 'in_progress');
    const dur = fmtDuration(localDur, effStatus);
    return {
      runId: entry.runId,
      conclusion: entry.conclusion,
      status: effStatus,
      source: entry.source || '',
      destination: entry.destination || '',
      arch: entry.arch || '',
      duration: dur,
      text: label,
      meta: [metaStatusText(entry.conclusion, effStatus),
        fmtClock(entry.startedAt, dayBucket(entry.startedAt))].filter(Boolean).join(' · '),
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

/* ---------------- 搜索（D1 索引） ---------------- */

async function runSearch(q) {
  if (!q) {
    searchResults = null;
    searchTotal = 0;
    renderHistory();
    return;
  }
  const seq = ++searchSeq;
  try {
    const withDeleted = showDeleted && role === 'admin' ? '&includeDeleted=1' : '';
    const resp = await apiFetch(`/api/search?limit=50${withDeleted}&q=${encodeURIComponent(q)}`);
    if (resp.status === 401) {
      handleUnauthorized('登录已过期，请重新登录');
      return;
    }
    const data = await resp.json();
    if (seq !== searchSeq) return; // 已有更新的输入，丢弃旧结果
    if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    searchResults = data.runs || [];
    searchTotal = data.total || searchResults.length;
  } catch (err) {
    if (seq !== searchSeq) return;
    searchResults = [];
    searchTotal = 0;
    showResult('error', `搜索失败：${err.message}`);
  }
  renderHistory();
}

function scheduleSearch() {
  const q = (historySearch && historySearch.value ? historySearch.value : '').trim();
  if (searchTimer) clearTimeout(searchTimer);
  // 输入为空立刻回到最近列表，否则 300ms 防抖
  if (!q) {
    runSearch('');
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 300);
}

/* ---------------- 管理员：管理模式与删除 ---------------- */

function applyRole() {
  if (adminToggleBtn) {
    adminToggleBtn.hidden = !(role === 'admin' && adminEnabled);
  }
  if (!adminMode && bulkBar) bulkBar.hidden = true;
}

function setAdminMode(on) {
  adminMode = on;
  selectedRunIds.clear();
  showDeleted = false;
  if (showDeletedBox) showDeletedBox.checked = false;
  if (bulkBar) bulkBar.hidden = !on;
  if (selectAllBox) selectAllBox.checked = false;
  if (adminToggleBtn) adminToggleBtn.textContent = on ? '退出管理' : '管理';
  updateBulkCount();
  renderHistory();
}

function updateBulkCount() {
  if (bulkCountEl) bulkCountEl.textContent = `已选 ${selectedRunIds.size} 条`;
  if (bulkDeleteBtn) bulkDeleteBtn.disabled = selectedRunIds.size === 0;
  if (selectAllBox) {
    const boxes = historyList ? historyList.querySelectorAll('.hist-select') : [];
    selectAllBox.checked = boxes.length > 0 && selectedRunIds.size === boxes.length;
  }
}

/** 删除后同步清理本地缓存，避免回退时又冒出来 */
function purgeLocalCaches(ids) {
  const set = new Set(ids.map(Number));
  try {
    const hist = loadHistory().filter((e) => !set.has(Number(e.runId)));
    saveHistory(hist);
  } catch { /* ignore */ }
  try {
    const raw = sessionStorage.getItem(RUNS_CACHE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.runs)) {
        data.runs = data.runs.filter((r) => !set.has(Number(r.id)));
        sessionStorage.setItem(RUNS_CACHE_KEY, JSON.stringify(data));
      }
    }
  } catch { /* ignore */ }
  globalRuns = globalRuns.filter((r) => !set.has(Number(r.id)));
  if (Array.isArray(searchResults)) {
    searchResults = searchResults.filter((r) => !set.has(Number(r.id)));
    searchTotal = Math.max(0, searchTotal - set.size);
  }
  ids.forEach((id) => selectedRunIds.delete(Number(id)));
}

async function deleteRuns(ids) {
  const list = [...new Set(ids.map(Number))].filter((n) => Number.isFinite(n) && n > 0);
  if (!list.length) return;

  const confirmed = window.confirm(
    `将删除 ${list.length} 条运行记录及其日志，删除后不可恢复。\n\n确定继续？`
  );
  if (!confirmed) return;

  if (bulkDeleteBtn) bulkDeleteBtn.disabled = true;
  showResult('loading', `正在删除 ${list.length} 条记录…`);

  try {
    let deleted = 0;
    let failed = [];
    if (list.length === 1) {
      const resp = await apiFetch(`/api/runs/${list[0]}`, { method: 'DELETE' });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.ok) deleted = 1;
      else failed = [list[0]];
    } else {
      const resp = await apiFetch('/api/runs/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: list }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok || resp.status === 502) {
        deleted = data.deleted || 0;
        failed = (data.results || []).filter((r) => !r.ok).map((r) => r.id);
        if (data.error && !(data.results || []).length) throw new Error(data.error);
      } else {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
    }

    purgeLocalCaches(list.filter((id) => !failed.includes(id)));
    await refreshHistory();
    if (Array.isArray(searchResults)) scheduleSearch();

    if (failed.length) {
      showResult('error', `已删除 ${deleted} 条，${failed.length} 条失败（可能仍在运行或已被删除）`);
    } else {
      showResult('success', `✅ 已删除 ${deleted} 条记录`);
    }
  } catch (err) {
    showResult('error', `❌ 删除失败：${err.message}`);
  } finally {
    updateBulkCount();
    if (bulkDeleteBtn) bulkDeleteBtn.disabled = selectedRunIds.size === 0;
  }
}

/** 拉取全局运行记录（失败则回退本地缓存） */
async function refreshHistory() {
  if (!getToken()) {
    historyMode = 'local';
    historyLoading = false;
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
    writeRunsCache(globalRuns);
  } catch {
    // 已有会话快照时保留它，避免回退到更旧的本地缓存
    if (!globalRuns.length) historyMode = 'local';
  } finally {
    historyLoading = false;
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
      // 刻意不预选架构：默认值会让用户以为系统已替他选好，导致漏选
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
      closeDrawer();
      hideBar();
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

      trackingActive = false;
      hideBar();
      return;
    }

    if (!drawerIsOpen()) showBar(text);
    clearResult();
    pollTimer = setTimeout(() => pollStatus(runId, data.html_url || htmlUrl, destination), POLL_INTERVAL_MS);
  } catch (err) {
    pollTimer = setTimeout(() => pollStatus(runId, htmlUrl, destination), POLL_INTERVAL_MS * 2);
    const message = `获取进度失败，正在重试…`;
    if (drawerIsOpen()) showResult('loading', message);
    else showBar(message);
  }
}

function startTracking(runId, htmlUrl, destination) {
  stopPolling();
  pollStartedAt = Date.now();
  trackingActive = true;
  clearResult();
  openDrawer();
  stepList.innerHTML = '';
  setBadge('queued', '排队中');
  progressTitle.textContent = '同步进度';
  if (htmlUrl) runLink.href = htmlUrl;
  runLink.style.display = htmlUrl ? 'inline-block' : 'none';
  pollStatus(runId, htmlUrl, destination);
}

/** 刷新后恢复上次同步的进度（默认只显示状态条，不主动弹出抽屉） */
async function restoreLastRun() {
  const last = loadLastRun();
  if (!last) return;

  stepList.innerHTML = '';
  setBadge('queued', '查询中…');
  progressTitle.textContent = '上次同步';
  if (last.htmlUrl) {
    runLink.href = last.htmlUrl;
    runLink.style.display = 'inline-block';
  }

  trackingActive = true;
  showBar(last.conclusion ? '上次同步已结束' : '正在同步…');

  pollStartedAt = Date.now();
  pollStatus(last.runId, last.htmlUrl, last.destination);
}

/* ---------------- 事件 ---------------- */

sourceInput.addEventListener('input', renderPreview);
orgInput.addEventListener('input', renderPreview);

if (resolveToggle && resolveDetail) {
  resolveToggle.addEventListener('click', () => {
    const expanded = resolveToggle.getAttribute('aria-expanded') === 'true';
    resolveDetail.hidden = expanded;
    resolveToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    resolveToggle.textContent = expanded ? '详情' : '收起';
  });
}

if (archChips) {
  archChips.addEventListener('change', () => {
    clearArchError();
    renderPreview();
  });
}

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
      role = data.role || 'user';
      adminEnabled = Boolean(data.role === 'admin');
      applyRole();
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
  trackingActive = false;
  closeDrawer();
  hideBar();
  showResult('error', '已退出登录。');
  showLogin('已退出登录');
});

if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeDrawer);
if (progressBarBtn) progressBarBtn.addEventListener('click', openDrawer);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drawerIsOpen()) closeDrawer();
});

if (historySearch) {
  historySearch.addEventListener('input', scheduleSearch);
}

if (adminToggleBtn) {
  adminToggleBtn.addEventListener('click', () => setAdminMode(!adminMode));
}

if (selectAllBox) {
  selectAllBox.addEventListener('change', () => {
    const boxes = historyList ? historyList.querySelectorAll('.hist-select') : [];
    selectedRunIds.clear();
    boxes.forEach((box) => {
      box.checked = selectAllBox.checked;
      if (selectAllBox.checked) {
        const id = Number(box.dataset.runId);
        if (Number.isFinite(id)) selectedRunIds.add(id);
      }
    });
    updateBulkCount();
  });
}

if (bulkDeleteBtn) {
  bulkDeleteBtn.addEventListener('click', () => {
    if (!selectedRunIds.size) return;
    deleteRuns([...selectedRunIds]);
  });
}

if (showDeletedBox) {
  showDeletedBox.addEventListener('change', () => {
    showDeleted = Boolean(showDeletedBox.checked);
    const q = (historySearch && historySearch.value ? historySearch.value : '').trim();
    if (q) {
      scheduleSearch();
    } else {
      // 没有关键字时搜索不生效，给个提示
      if (searchNote) {
        searchNote.textContent = showDeleted
          ? '输入关键字搜索时，结果将包含已删除的记录'
          : '';
        searchNote.hidden = !showDeleted;
      }
    }
  });
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
  const arch = selectedArch();
  const makePublic = isPublicInput ? isPublicInput.checked : true;

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
  if (!arch) {
    showArchError();
    showResult('error', '请先选择目标架构（不确定就在目标服务器执行 uname -m）');
    return;
  }
  clearArchError();

  submitBtn.disabled = true;
  submitBtn.textContent = '触发中…';
  closeDrawer();
  hideBar();
  showResult('loading', '正在触发同步任务…');

  try {
    const response = await apiFetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, org, arch, public: makePublic }),
    });

    if (response.status === 401) {
      handleUnauthorized('登录已过期，请重新登录');
      submitBtn.disabled = false;
      submitBtn.textContent = '开始同步';
      return;
    }

    const data = await response.json();

    if (response.ok && data.ok) {
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
  if (IS_FILE_PROTOCOL) {
    renderHistory();
    showLogin(OPEN_HINT);
    return;
  }

  const token = getToken();
  if (token) {
    // 有会话快照就先渲染（刷新零等待），后台再校验更新；没有则显示加载态
    const cached = readRunsCache();
    if (cached) {
      globalRuns = cached.runs;
      historyMode = 'global';
      historyLoading = false;
      renderHistory();
    } else {
      historyLoading = true;
      renderHistory();
    }
    try {
      const resp = await apiFetch('/api/session');
      if (resp.ok) {
        const session = await resp.json().catch(() => ({}));
        role = session.role || 'user';
        adminEnabled = Boolean(session.adminEnabled);
        applyRole();
        showApp();
        await loadConfig();
        refreshHistory();
        restoreLastRun();
        return;
      }
    } catch { /* 网络异常则回到登录 */ }
    historyLoading = false;
    clearToken();
  }

  renderHistory();
  showLogin();
}

boot();
