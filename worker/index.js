/**
 * Cloudflare Worker — Serverless 代理
 *
 * 接口:
 *   GET  /api/config           返回 SWR registry 与默认组织（供前端展示）
 *   POST /api/sync             触发同步
 *       body: { "source": string, "org"?: string }
 *             （兼容旧参数："destination": string, "tags": string）
 *       200 { "ok": true, "run_id": number, "html_url": string, "destination": string }
 *       400 { "error": string } / 502 { "ok": false, "error": string }
 *
 *   GET  /api/status?id=<run_id>   查询同步进度
 *
 * 环境变量:
 *   GITHUB_REPO, WORKFLOW_ID, GITHUB_TOKEN  （必填）
 *   SWR_REGISTRY  目标 SWR 域名，默认 swr.cn-east-4.myhuaweicloud.com
 *   SWR_ORG       默认目标组织，默认 ascend-sync
 *   ALLOWED_ORIGIN 可选，前端域名，默认 *
 */

const GITHUB_API = 'https://api.github.com';
const DEFAULT_REGISTRY = 'swr.cn-east-4.myhuaweicloud.com';
const DEFAULT_ORG = 'ascend-sync';
const DEFAULT_TAG = 'latest';
const DEFAULT_ARCH = 'amd64';
const ALLOWED_ARCHS = new Set(['amd64', 'arm64', 'all']);

function corsHeaders(env) {
  const origin = (env && env.ALLOWED_ORIGIN) ? env.ALLOWED_ORIGIN : '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(env),
    },
  });
}

function optionsResponse(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

async function githubFetch(env, path, init = {}) {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'image-sync-worker',
      ...(init.headers || {}),
    },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 访问口令认证 ---------------- */

const AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 令牌有效期 7 天
const encoder = new TextEncoder();

function base64url(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
  const ab = encoder.encode(String(a));
  const bb = encoder.encode(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function hmacKey(env) {
  // 用 APP_PASSWORD 作为签名密钥；改口令即让所有令牌失效
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.APP_PASSWORD),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function signPayload(env, payload) {
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return base64url(sig);
}

/** 令牌格式：v1.<role>.<exp>.<sig>，role 由签名保护，无法伪造 */
async function issueToken(env, role = 'user') {
  const exp = Date.now() + AUTH_TTL_MS;
  const payload = `v1.${role}.${exp}`;
  const sig = await signPayload(env, payload);
  return { token: `${payload}.${sig}`, expires_at: new Date(exp).toISOString(), role };
}

async function verifyToken(env, token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, role, expRaw, sig] = parts;
  if (role !== 'user' && role !== 'admin') return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  const expected = await signPayload(env, `v1.${role}.${exp}`);
  if (!timingSafeEqual(sig, expected)) return null;
  return { role, exp };
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return (request.headers.get('X-Auth-Token') || '').trim();
}

/**
 * 校验登录态；通过返回 null，否则返回错误响应。
 * requireAdmin 为 true 时还要求 role === 'admin'。
 */
async function requireAuth(request, env, { requireAdmin = false } = {}) {
  if (!env.APP_PASSWORD) {
    return jsonResponse(env, { error: '服务端未配置访问口令（APP_PASSWORD）' }, 500);
  }
  const payload = await verifyToken(env, bearerToken(request));
  if (!payload) {
    return jsonResponse(env, { error: '未登录或登录已过期' }, 401);
  }
  if (requireAdmin && payload.role !== 'admin') {
    return jsonResponse(env, { error: '需要管理员权限' }, 403);
  }
  return null;
}

/** 当前请求的角色，供 /api/session 返回 */
async function currentRole(request, env) {
  const payload = await verifyToken(env, bearerToken(request));
  return payload ? payload.role : null;
}

async function handleLogin(request, env) {
  if (!env.APP_PASSWORD) {
    return jsonResponse(env, { error: '服务端未配置访问口令（APP_PASSWORD）' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(env, { error: 'Invalid JSON body' }, 400);
  }

  const password = String((body && body.password) || '');
  if (!password) {
    return jsonResponse(env, { error: '请输入访问口令' }, 400);
  }

  // 先比管理员口令（若已配置），再比普通口令
  let role = null;
  if (env.ADMIN_PASSWORD && timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    role = 'admin';
  } else if (timingSafeEqual(password, env.APP_PASSWORD)) {
    role = 'user';
  }

  if (!role) {
    await sleep(300); // 轻微延迟，降低暴力破解速度
    return jsonResponse(env, { error: '口令错误' }, 401);
  }

  const { token, expires_at } = await issueToken(env, role);
  return jsonResponse(env, { ok: true, token, expires_at, role });
}

/* ---------------- D1 同步索引 ---------------- */

/** 从完整目标地址拆出 registry / org / repo / tag，用于高效查询 */
function splitDestination(destination) {
  const d = String(destination || '').trim();
  if (!d) return { registry: null, org: null, repo: null, tag: null };

  let rest = d;
  const slash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  let tag = null;
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split('/').filter(Boolean);
  const first = parts[0] || '';
  const hasRegistry = parts.length >= 3 && (first.includes('.') || first.includes(':'));
  if (!hasRegistry) {
    return {
      registry: null,
      org: parts.length >= 2 ? parts[0] : null,
      repo: parts[parts.length - 1] || null,
      tag,
    };
  }
  return {
    registry: first,
    org: parts[1] || null,
    repo: parts[2] || null,
    tag,
  };
}

/** 触发成功后写入一条（幂等：同一 run_id 重复写入则更新） */
async function recordSyncStart(env, { runId, source, destination, arch, createdAt }) {
  if (!env.DB || !runId) return;
  const { registry, org, repo, tag } = splitDestination(destination);
  try {
    await env.DB.prepare(
      `INSERT INTO syncs (run_id, source, destination, registry, org, repo, tag, arch, conclusion, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)
       ON CONFLICT(run_id) DO UPDATE SET
         source = excluded.source,
         destination = excluded.destination,
         registry = excluded.registry,
         org = excluded.org,
         repo = excluded.repo,
         tag = excluded.tag,
         arch = excluded.arch`
    ).bind(runId, source, destination, registry, org, repo, tag, arch, createdAt).run();
  } catch (err) {
    console.error('recordSyncStart failed:', err && err.message);
  }
}

/** 运行结束后补结论与耗时 */
async function recordSyncFinish(env, runId, conclusion, durationSeconds, finishedAt) {
  if (!env.DB || !runId) return;
  try {
    await env.DB.prepare(
      `UPDATE syncs SET conclusion = ?2, duration_seconds = ?3, finished_at = ?4
       WHERE run_id = ?1`
    ).bind(runId, conclusion, durationSeconds, finishedAt).run();
  } catch (err) {
    console.error('recordSyncFinish failed:', err && err.message);
  }
}

/** 同步统计：近 N 天的次数 / 成功率 / 耗时，以及按天序列供前端画趋势 */
async function handleStats(env, url) {
  if (!env.DB) {
    return jsonResponse(env, { error: '服务端未绑定 D1（DB）' }, 500);
  }

  const rawDays = Number(url.searchParams.get('days'));
  const days = [7, 30, 90].includes(rawDays) ? rawDays : 30;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const totals = await env.DB.prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN conclusion = 'success' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN conclusion = 'failure' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN conclusion IN ('cancelled','skipped') THEN 1 ELSE 0 END) AS other,
              SUM(COALESCE(duration_seconds, 0)) AS total_duration,
              AVG(duration_seconds) AS avg_duration,
              COUNT(DISTINCT repo) AS repos
         FROM syncs
        WHERE created_at >= ?1 AND deleted_at IS NULL`
    ).bind(cutoff).first();

    const series = await env.DB.prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS n,
              AVG(duration_seconds) AS avg_duration
         FROM syncs
        WHERE created_at >= ?1 AND deleted_at IS NULL
        GROUP BY day
        ORDER BY day`
    ).bind(cutoff).all();

    const slowest = await env.DB.prepare(
      `SELECT run_id, source, destination, arch, conclusion, duration_seconds, created_at
         FROM syncs
        WHERE created_at >= ?1 AND deleted_at IS NULL AND duration_seconds IS NOT NULL
        ORDER BY duration_seconds DESC
        LIMIT 3`
    ).bind(cutoff).all();

    const topRepos = await env.DB.prepare(
      `SELECT repo, COUNT(*) AS n,
              SUM(CASE WHEN conclusion = 'success' THEN 1 ELSE 0 END) AS ok
         FROM syncs
        WHERE created_at >= ?1 AND deleted_at IS NULL
        GROUP BY repo
        ORDER BY n DESC
        LIMIT 5`
    ).bind(cutoff).all();

    const t = totals || {};
    return jsonResponse(env, {
      ok: true,
      days,
      cutoff,
      totals: {
        runs: t.n || 0,
        success: t.ok || 0,
        failure: t.failed || 0,
        other: t.other || 0,
        successRate: t.n ? Math.round((t.ok || 0) / t.n * 100) : 0,
        totalDuration: t.total_duration || 0,
        avgDuration: t.avg_duration ? Math.round(t.avg_duration) : null,
        repos: t.repos || 0,
      },
      series: (series.results || []).map((r) => ({
        day: r.day,
        runs: r.n,
        avgDuration: r.avg_duration ? Math.round(r.avg_duration) : null,
      })),
      slowest: (slowest.results || []).map((r) => ({
        id: r.run_id,
        source: r.source,
        destination: r.destination,
        arch: r.arch,
        conclusion: r.conclusion,
        durationSeconds: r.duration_seconds,
        createdAt: r.created_at,
      })),
      topRepos: (topRepos.results || []).map((r) => ({ repo: r.repo, runs: r.n, success: r.ok || 0 })),
    });
  } catch (err) {
    console.error('stats failed:', err && err.message);
    return jsonResponse(env, { ok: false, error: '统计查询失败' }, 502);
  }
}

/** 搜索历史索引；includeDeleted 仅管理员可用（审计已删除记录） */
async function handleSearch(env, url, { isAdmin = false } = {}) {
  if (!env.DB) {
    return jsonResponse(env, { error: '服务端未绑定 D1（DB）' }, 500);
  }

  const q = (url.searchParams.get('q') || '').trim();
  if (!q) {
    return jsonResponse(env, { ok: true, runs: [], total: 0 });
  }

  const rawLimit = Number(url.searchParams.get('limit'));
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 1), 100);
  const like = `%${q}%`;
  const includeDeleted = isAdmin && url.searchParams.get('includeDeleted') === '1';
  const deletedFilter = includeDeleted ? '' : 'AND deleted_at IS NULL';

  try {
    const stmt = env.DB.prepare(
      `SELECT run_id, source, destination, arch, conclusion, duration_seconds, created_at, deleted_at
         FROM syncs
        WHERE (source LIKE ?1 OR destination LIKE ?1 OR repo LIKE ?1 OR tag LIKE ?1 OR arch LIKE ?1)
          ${deletedFilter}
        ORDER BY created_at DESC
        LIMIT ?2`
    ).bind(like, limit);
    const { results } = await stmt.all();

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM syncs
        WHERE (source LIKE ?1 OR destination LIKE ?1 OR repo LIKE ?1 OR tag LIKE ?1 OR arch LIKE ?1)
          ${deletedFilter}`
    ).bind(like).first();

    return jsonResponse(env, {
      ok: true,
      includeDeleted,
      total: (countRow && countRow.n) || 0,
      runs: (results || []).map((r) => ({
        id: r.run_id,
        source: r.source,
        destination: r.destination,
        arch: r.arch,
        conclusion: r.conclusion,
        duration_seconds: r.duration_seconds,
        created_at: r.created_at,
        deleted_at: r.deleted_at || null,
        html_url: `https://github.com/${env.GITHUB_REPO}/actions/runs/${r.run_id}`,
        title: `Sync ${r.source} → ${r.destination}${r.arch === 'all' ? ' [amd64+arm64]' : r.arch ? ` [${r.arch}]` : ''}`,
      })),
    });
  } catch (err) {
    console.error('search failed:', err && err.message);
    return jsonResponse(env, { ok: false, error: '搜索失败（索引查询异常）' }, 502);
  }
}

/* ---------------- 管理员：删除历史记录 ---------------- */

/** 删除单条 GitHub 运行，并在索引里标记为已删除 */
async function deleteRun(env, runIdRaw) {
  const runId = Number(runIdRaw);
  if (!Number.isFinite(runId) || runId <= 0) {
    return { id: runIdRaw, ok: false, error: 'id 无效' };
  }

  try {
    const resp = await githubFetch(env, `/repos/${env.GITHUB_REPO}/actions/runs/${runId}`, {
      method: 'DELETE',
    });
    // 204 = 删除成功；404 = 已经不存在（视为成功，顺手清理索引）
    if (resp.status !== 204 && resp.status !== 404) {
      let message = `GitHub 返回 ${resp.status}`;
      try {
        const data = await resp.json();
        if (data && data.message) message = data.message;
      } catch { /* ignore */ }
      return { id: runId, ok: false, error: message };
    }
    if (env.DB) {
      await env.DB.prepare('UPDATE syncs SET deleted_at = ?2 WHERE run_id = ?1')
        .bind(runId, new Date().toISOString()).run();
    }
    return { id: runId, ok: true };
  } catch (err) {
    console.error('deleteRun failed:', err && err.message);
    return { id: runId, ok: false, error: '删除失败（网络异常）' };
  }
}

async function handleDeleteRun(env, runIdRaw) {
  if (!env.ADMIN_PASSWORD) {
    return jsonResponse(env, { error: '未配置管理员口令，删除功能已关闭' }, 501);
  }
  const result = await deleteRun(env, runIdRaw);
  if (!result.ok) {
    return jsonResponse(env, { ok: false, error: result.error }, 502);
  }
  return jsonResponse(env, { ok: true, id: result.id });
}

async function handleBulkDelete(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return jsonResponse(env, { error: '未配置管理员口令，删除功能已关闭' }, 501);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(env, { error: 'Invalid JSON body' }, 400);
  }

  const ids = Array.isArray(body && body.ids) ? body.ids : [];
  if (!ids.length) {
    return jsonResponse(env, { error: 'ids 不能为空' }, 400);
  }
  if (ids.length > 50) {
    return jsonResponse(env, { error: '单次最多删除 50 条' }, 400);
  }

  const results = [];
  for (const id of ids) {
    results.push(await deleteRun(env, id));
  }
  const failed = results.filter((r) => !r.ok);
  return jsonResponse(env, {
    ok: failed.length === 0,
    deleted: results.filter((r) => r.ok).length,
    failed: failed.length,
    results,
  });
}

function registryOf(env) {
  return (env.SWR_REGISTRY || DEFAULT_REGISTRY).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * 校验组织名（SWR 组织名：字母数字开头，可含 . _ -）
 */
function normalizeOrg(env, org) {
  const value = (org && String(org).trim()) || (env.SWR_ORG ? String(env.SWR_ORG).trim() : DEFAULT_ORG);
  if (!value) throw new Error('目标组织不能为空');
  if (value.includes('/') || /\s/.test(value)) throw new Error('目标组织不合法（不能包含 / 或空格）');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error('目标组织不合法（只能包含字母、数字、点、下划线、连字符）');
  }
  return value;
}

/**
 * 解析镜像地址，返回 { repo, tag }；tag 可能为 null
 * 例：
 *   docker.io/library/nginx:1.25.3        -> { repo: 'nginx', tag: '1.25.3' }
 *   quay.io/prometheus/node-exporter      -> { repo: 'node-exporter', tag: null }
 *   registry:5000/team/app:v1             -> { repo: 'app', tag: 'v1' }
 */
function parseImage(source) {
  let s = String(source || '').trim();
  if (!s) return null;

  // 去掉 digest
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

/**
 * 由源地址推导 SWR 目标地址
 */
function buildDestination(env, source, orgRaw) {
  const parsed = parseImage(source);
  if (!parsed) throw new Error('无法解析源镜像地址');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parsed.repo)) {
    throw new Error('源镜像名称不合法');
  }

  const org = normalizeOrg(env, orgRaw);
  const tag = parsed.tag || DEFAULT_TAG;
  return {
    destination: `${registryOf(env)}/${org}/${parsed.repo}:${tag}`,
    // 交给 workflow 的源地址：显式补齐 tag，确保只同步单个 tag
    source: `${source.trim()}${parsed.tag ? '' : `:${DEFAULT_TAG}`}`,
    repo: parsed.repo,
    tag,
    org,
  };
}

function normalizeArch(arch) {
  const value = (arch && String(arch).trim().toLowerCase()) || DEFAULT_ARCH;
  if (!ALLOWED_ARCHS.has(value)) {
    throw new Error('不支持的架构，可选：amd64 / arm64 / all（all = amd64 + arm64）');
  }
  return value;
}

/** 是否把镜像设为公开，默认 true */
function normalizePublic(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return true;
}

async function handleConfig(env) {
  return jsonResponse(env, {
    ok: true,
    registry: registryOf(env),
    default_org: (env.SWR_ORG || DEFAULT_ORG).trim(),
    default_arch: DEFAULT_ARCH,
  });
}

/**
 * 校验并触发同步
 */
async function handleSync(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(env, { error: 'Invalid JSON body' }, 400);
  }

  const { source, destination, tags, org, arch } = body || {};
  const publicValue = normalizePublic(body && body.public);

  if (!source || typeof source !== 'string' || !source.trim()) {
    return jsonResponse(env, { error: 'source 不能为空' }, 400);
  }
  if (!env.GITHUB_REPO || !env.WORKFLOW_ID || !env.GITHUB_TOKEN) {
    return jsonResponse(env, { error: 'Server misconfiguration' }, 500);
  }

  let archValue;
  try {
    archValue = normalizeArch(arch);
  } catch (err) {
    return jsonResponse(env, { error: err.message }, 400);
  }

  let target;
  try {
    if (destination && String(destination).trim()) {
      // 兼容旧调用：显式传入目标地址
      const dest = String(destination).trim();
      if (!dest.includes('swr.')) {
        return jsonResponse(env, { error: '目标仓库仅支持华为云 SWR（destination 需包含 swr. 域名）' }, 400);
      }
      target = { destination: dest, source: source.trim() };
    } else {
      target = buildDestination(env, source, org);
    }
  } catch (err) {
    return jsonResponse(env, { error: err.message }, 400);
  }

  const dispatchPath = `/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_ID}/dispatches`;
  const startedAt = Date.now();

  let dispatchResp;
  try {
    dispatchResp = await githubFetch(env, dispatchPath, {
      method: 'POST',
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          source: target.source,
          destination: target.destination,
          tags: (tags || '').trim(),
          arch: archValue,
          public: String(publicValue),
        },
      }),
    });
  } catch (err) {
    console.error('dispatch failed:', err);
    return jsonResponse(env, { ok: false, error: 'Failed to contact GitHub API' }, 502);
  }

  if (dispatchResp.status !== 204) {
    let message = `GitHub API returned ${dispatchResp.status}`;
    try {
      const data = await dispatchResp.json();
      if (data && data.message) message = data.message;
    } catch { /* ignore */ }
    return jsonResponse(env, { ok: false, error: message }, 502);
  }

  // workflow_dispatch 不返回 run id，短暂轮询定位本次运行
  for (let i = 0; i < 6; i++) {
    try {
      const resp = await githubFetch(
        env,
        `/repos/${env.GITHUB_REPO}/actions/runs?event=workflow_dispatch&per_page=10`
      );
      if (resp.ok) {
        const data = await resp.json();
        const run = (data.workflow_runs || []).find((r) =>
          r.path === `.github/workflows/${env.WORKFLOW_ID}` &&
          new Date(r.created_at).getTime() >= startedAt - 15000
        );
        if (run) {
          // 写入 D1 索引（失败不影响触发结果）
          await recordSyncStart(env, {
            runId: run.id,
            source: target.source,
            destination: target.destination,
            arch: archValue,
            createdAt: run.created_at || new Date().toISOString(),
          });
          return jsonResponse(env, {
            ok: true,
            run_id: run.id,
            html_url: run.html_url,
            destination: target.destination,
            arch: archValue,
          });
        }
      }
    } catch (err) {
      console.error('lookup run failed:', err);
    }
    await sleep(1500);
  }

  return jsonResponse(env, { ok: true, destination: target.destination, arch: archValue });
}

/**
 * 查询运行进度
 */
async function handleStatus(env, url) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) {
    return jsonResponse(env, { error: 'Server misconfiguration' }, 500);
  }

  const id = url.searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) {
    return jsonResponse(env, { error: 'id 参数无效' }, 400);
  }

  try {
    const runResp = await githubFetch(env, `/repos/${env.GITHUB_REPO}/actions/runs/${id}`);
    if (runResp.status === 404) {
      return jsonResponse(env, { error: '运行不存在' }, 404);
    }
    if (!runResp.ok) {
      return jsonResponse(env, { ok: false, error: `GitHub API returned ${runResp.status}` }, 502);
    }
    const run = await runResp.json();

    let steps = [];
    const jobsResp = await githubFetch(env, `/repos/${env.GITHUB_REPO}/actions/runs/${id}/jobs`);
    if (jobsResp.ok) {
      const jobs = await jobsResp.json();
      steps = (jobs.jobs || []).flatMap((job) =>
        (job.steps || []).map((s) => ({
          name: s.name,
          status: s.status,
          conclusion: s.conclusion,
        }))
      );
    }

    // 完成时把结论回写索引（幂等，重复轮询只更新同一行）
    if (run.status === 'completed') {
      const duration = durationBetween(run.run_started_at || run.created_at, run.updated_at);
      await recordSyncFinish(env, Number(id), run.conclusion, duration, run.updated_at);
    }

    return jsonResponse(env, {
      ok: true,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      created_at: run.created_at,
      steps,
    });
  } catch (err) {
    console.error('status failed:', err);
    return jsonResponse(env, { ok: false, error: 'Failed to contact GitHub API' }, 502);
  }
}

/**
 * 全局同步历史：读取该仓库最近的工作流运行
 */
function durationBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}

async function handleRuns(env, url) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) {
    return jsonResponse(env, { error: 'Server misconfiguration' }, 500);
  }

  const rawLimit = Number(url.searchParams.get('limit'));
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 15, 1), 50);

  try {
    const resp = await githubFetch(
      env,
      `/repos/${env.GITHUB_REPO}/actions/runs?per_page=${limit}`
    );
    if (!resp.ok) {
      return jsonResponse(env, { ok: false, error: `GitHub API returned ${resp.status}` }, 502);
    }

    const data = await resp.json();
    const now = Date.now();
    const runs = (data.workflow_runs || [])
      .filter((r) => r.path === `.github/workflows/${env.WORKFLOW_ID}`)
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        title: r.display_title || '',
        status: r.status,
        conclusion: r.conclusion,
        created_at: r.created_at,
        // 耗时：已完成用 updated_at，进行中用当前时间
        duration_seconds: durationBetween(r.run_started_at || r.created_at,
          r.status === 'completed' ? r.updated_at : new Date(now).toISOString()),
        html_url: r.html_url,
      }));

    return jsonResponse(env, { ok: true, runs });
  } catch (err) {
    console.error('runs failed:', err);
    return jsonResponse(env, { ok: false, error: 'Failed to contact GitHub API' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return optionsResponse(env);
    }

    // 登录：无需鉴权
    if (url.pathname === '/api/login') {
      if (request.method !== 'POST') {
        return jsonResponse(env, { error: 'Method not allowed. Use POST /api/login' }, 405);
      }
      return handleLogin(request, env);
    }

    // 以下接口均需登录
    if (url.pathname === '/api/session') {
      if (request.method !== 'GET') {
        return jsonResponse(env, { error: 'Method not allowed. Use GET /api/session' }, 405);
      }
      const authError = await requireAuth(request, env);
      if (authError) return authError;
      return jsonResponse(env, {
        ok: true,
        role: await currentRole(request, env),
        adminEnabled: Boolean(env.ADMIN_PASSWORD),
      });
    }

    if (url.pathname === '/api/stats') {
      if (request.method !== 'GET') {
        return jsonResponse(env, { error: 'Method not allowed. Use GET /api/stats?days=30' }, 405);
      }
      const authError = await requireAuth(request, env);
      if (authError) return authError;
      return handleStats(env, url);
    }

    if (url.pathname === '/api/search') {
      if (request.method !== 'GET') {
        return jsonResponse(env, { error: 'Method not allowed. Use GET /api/search?q=' }, 405);
      }
      const authError = await requireAuth(request, env);
      if (authError) return authError;
      return handleSearch(env, url, { isAdmin: (await currentRole(request, env)) === 'admin' });
    }

    // 批量删除（管理员）
    if (url.pathname === '/api/runs/bulk-delete') {
      if (request.method !== 'POST') {
        return jsonResponse(env, { error: 'Method not allowed. Use POST /api/runs/bulk-delete' }, 405);
      }
      const authError = await requireAuth(request, env, { requireAdmin: true });
      if (authError) return authError;
      return handleBulkDelete(request, env);
    }

    // 单条删除（管理员）：/api/runs/<id>
    const deleteMatch = url.pathname.match(/^\/api\/runs\/(\d+)$/);
    if (deleteMatch) {
      if (request.method !== 'DELETE') {
        return jsonResponse(env, { error: 'Method not allowed. Use DELETE /api/runs/<id>' }, 405);
      }
      const authError = await requireAuth(request, env, { requireAdmin: true });
      if (authError) return authError;
      return handleDeleteRun(env, deleteMatch[1]);
    }

    if (url.pathname === '/api/config') {
      if (request.method !== 'GET') {
        return jsonResponse(env, { error: 'Method not allowed. Use GET /api/config' }, 405);
      }
      const authError = await requireAuth(request, env);
      if (authError) return authError;
      return handleConfig(env);
    }

    if (url.pathname === '/api/sync') {
      if (request.method !== 'POST') {
        return jsonResponse(env, { error: 'Method not allowed. Use POST /api/sync' }, 405);
      }
      const authError = await requireAuth(request, env);
      if (authError) return authError;
      return handleSync(request, env);
    }

    if (url.pathname === '/api/runs') {
      if (request.method !== 'GET') {
        return jsonResponse(env, { error: 'Method not allowed. Use GET /api/runs' }, 405);
      }
      const authError = await requireAuth(request, env);
      if (authError) return authError;
      return handleRuns(env, url);
    }

    if (url.pathname === '/api/status') {
      if (request.method !== 'GET') {
        return jsonResponse(env, { error: 'Method not allowed. Use GET /api/status?id=...' }, 405);
      }
      const authError = await requireAuth(request, env);
      if (authError) return authError;
      return handleStatus(env, url);
    }

    return jsonResponse(env, { error: 'Not found' }, 404);
  },
};
