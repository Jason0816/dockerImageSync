/**
 * Cloudflare Worker — Serverless 代理
 * 
 * 接口: POST /api/sync
 * 请求体: { "source": string, "destination": string, "tags": string }
 * 响应: 200 { "ok": true } / 400 { "error": string } / 502 { "ok": false, "error": string }
 * 
 * 环境变量: GITHUB_REPO, WORKFLOW_ID, GITHUB_TOKEN
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',       // 生产环境应替换为前端实际域名
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    // 仅接受 POST
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed. Use POST /api/sync' }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname !== '/api/sync') {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    // 解析请求体
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { source, destination, tags } = body;

    // 校验必填字段
    if (!source || typeof source !== 'string' || !source.trim()) {
      return jsonResponse({ error: 'source 不能为空' }, 400);
    }
    if (!destination || typeof destination !== 'string' || !destination.trim()) {
      return jsonResponse({ error: 'destination 不能为空' }, 400);
    }

    // 校验 destination 必须包含 swr. 域名前缀
    if (!destination.includes('swr.')) {
      return jsonResponse({ error: '目标仓库仅支持华为云 SWR（destination 需包含 swr. 域名）' }, 400);
    }

    // 读取环境变量
    const { GITHUB_REPO, WORKFLOW_ID, GITHUB_TOKEN } = env;
    if (!GITHUB_REPO || !WORKFLOW_ID || !GITHUB_TOKEN) {
      console.error('Missing environment variables: GITHUB_REPO, WORKFLOW_ID, GITHUB_TOKEN');
      return jsonResponse({ error: 'Server misconfiguration' }, 500);
    }

    // 构造 GitHub Actions dispatch 请求
    const dispatchUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_ID}/dispatches`;

    const dispatchBody = {
      ref: 'main',
      inputs: {
        source: source.trim(),
        destination: destination.trim(),
        tags: (tags || '').trim(),
      },
    };

    try {
      const ghResponse = await fetch(dispatchUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dispatchBody),
      });

      if (ghResponse.status === 204) {
        return jsonResponse({ ok: true });
      }

      // GitHub 返回非 204
      const errorText = await ghResponse.text();
      let errorMessage = `GitHub API returned ${ghResponse.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.message) {
          errorMessage = errorJson.message;
        }
      } catch {
        // ignore parse error
      }

      return jsonResponse({ ok: false, error: errorMessage }, 502);
    } catch (err) {
      console.error('Failed to dispatch workflow:', err);
      return jsonResponse({ ok: false, error: 'Failed to contact GitHub API' }, 502);
    }
  },
};
