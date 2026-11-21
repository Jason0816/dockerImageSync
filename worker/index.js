/**
 * Cloudflare Worker — Serverless 代理
 *
 * 接口:
 *   POST /api/sync   触发同步
 *       body: { "source": string, "destination": string, "tags": string }
 *       200 { "ok": true, "run_id": number, "html_url": string }
 *       400 { "error": string } / 502 { "ok": false, "error": string }
 *
 *   GET /api/status?id=<run_id>   查询同步进度
 *       200 { "ok": true, "status": "queued|in_progress|completed",
 *             "conclusion": "success|failure|cancelled|...", "html_url": string,
 *             "steps": [{ "name": string, "status": string, "conclusion": string }] }
 *       400 / 404 / 502
 *
 * 环境变量: GITHUB_REPO, WORKFLOW_ID, GITHUB_TOKEN, ALLOWED_ORIGIN(可选)
 */

const GITHUB_API = 'https://api.github.com';

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

  const { source, destination, tags } = body || {};

  if (!source || typeof source !== 'string' || !source.trim()) {
    return jsonResponse(env, { error: 'source 不能为空' }, 400);
  }
  if (!destination || typeof destination !== 'string' || !destination.trim()) {
    return jsonResponse(env, { error: 'destination 不能为空' }, 400);
  }
  if (!destination.includes('swr.')) {
    return jsonResponse(env, { error: '目标仓库仅支持华为云 SWR（destination 需包含 swr. 域名）' }, 400);
  }
  if (!env.GITHUB_REPO || !env.WORKFLOW_ID || !env.GITHUB_TOKEN) {
    return jsonResponse(env, { error: 'Server misconfiguration' }, 500);
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
          source: source.trim(),
          destination: destination.trim(),
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

  // workflow_dispatch 不返回 run id，短暂轮询找到本次触发的运行
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
          return jsonResponse(env, { ok: true, run_id: run.id, html_url: run.html_url });
        }
      }
    } catch (err) {
      console.error('lookup run failed:', err);
    }
    await sleep(1500);
  }

  // 触发成功但暂时定位不到运行，前端可只显示“已触发”
  return jsonResponse(env, { ok: true });
}

/**
 * 查询运行进度
 */
async function handleStatus(request, env, url) {
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
      return handleStatus(request, env, url);
    }

    return jsonResponse(env, { error: 'Not found' }, 404);
  },
};
