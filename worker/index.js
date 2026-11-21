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

async function handleConfig(env) {
  return jsonResponse(env, {
    ok: true,
    registry: registryOf(env),
    default_org: (env.SWR_ORG || DEFAULT_ORG).trim(),
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

  const { source, destination, tags, org } = body || {};

  if (!source || typeof source !== 'string' || !source.trim()) {
    return jsonResponse(env, { error: 'source 不能为空' }, 400);
  }
  if (!env.GITHUB_REPO || !env.WORKFLOW_ID || !env.GITHUB_TOKEN) {
    return jsonResponse(env, { error: 'Server misconfiguration' }, 500);
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
          return jsonResponse(env, {
            ok: true,
            run_id: run.id,
            html_url: run.html_url,
            destination: target.destination,
          });
        }
      }
    } catch (err) {
      console.error('lookup run failed:', err);
    }
    await sleep(1500);
  }

  return jsonResponse(env, { ok: true, destination: target.destination });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return optionsResponse(env);
    }

    if (url.pathname === '/api/config') {
      if (request.method !== 'GET') {
        return jsonResponse(env, { error: 'Method not allowed. Use GET /api/config' }, 405);
      }
      return handleConfig(env);
    }

    if (url.pathname === '/api/sync') {
      if (request.method !== 'POST') {
        return jsonResponse(env, { error: 'Method not allowed. Use POST /api/sync' }, 405);
      }
      return handleSync(request, env);
    }

    if (url.pathname === '/api/status') {
      if (request.method !== 'GET') {
        return jsonResponse(env, { error: 'Method not allowed. Use GET /api/status?id=...' }, 405);
      }
      return handleStatus(env, url);
    }

    return jsonResponse(env, { error: 'Not found' }, 404);
  },
};
