/**
 * 前端逻辑 — 容器镜像同步
 * 
 * 注意：此处不得出现任何 GitHub Token 或 SWR 凭证。
 */

// ============================================================
// 配置：部署时替换为 Worker 实际地址
// 若使用 Cloudflare Pages 构建，可通过 define 注入 process.env.PROXY_URL
// ============================================================
const PROXY_URL = window.PROXY_URL || 'https://your-worker.your-subdomain.workers.dev';

// DOM 元素
const form = document.getElementById('syncForm');
const sourceInput = document.getElementById('source');
const destinationInput = document.getElementById('destination');
const tagsInput = document.getElementById('tags');
const submitBtn = document.getElementById('submitBtn');
const resultDiv = document.getElementById('result');

/**
 * 显示结果消息
 * @param {'success'|'error'|'loading'} type
 * @param {string} message
 */
function showResult(type, message) {
  resultDiv.className = type;
  resultDiv.textContent = message;
}

/**
 * 表单提交处理
 */
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const source = sourceInput.value.trim();
  const destination = destinationInput.value.trim();
  const tags = tagsInput.value.trim();

  // 前端校验
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

  // 禁用按钮，显示加载状态
  submitBtn.disabled = true;
  submitBtn.textContent = '提交中...';
  showResult('loading', '正在触发同步任务...');

  try {
    const response = await fetch(`${PROXY_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination, tags }),
    });

    const data = await response.json();

    if (response.ok && data.ok) {
      showResult('success', '✅ 已触发同步任务！请前往 GitHub Actions 页面查看执行进度。');
      // 清空表单
      sourceInput.value = '';
      destinationInput.value = '';
      tagsInput.value = '';
    } else {
      const errorMsg = data.error || `请求失败 (HTTP ${response.status})`;
      showResult('error', `❌ ${errorMsg}`);
    }
  } catch (err) {
    showResult('error', `❌ 网络错误，请检查代理地址是否正确：${err.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '触发同步';
  }
});
