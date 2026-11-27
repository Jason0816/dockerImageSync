#!/usr/bin/env python3
"""把 image-syncer 的英文失败日志归类成中文说明，写入 Job Summary 并输出 ::error 注解。

用法：
    python3 scripts/classify_sync_failure.py --log syncer.log \
        --source "cann:8.3.rc1" --arch arm64

始终以 0 退出（分类本身不是失败），由调用方决定步骤成败。
"""
import argparse
import os
import re
import sys

# (正则, 分类键, 中文标题, 处理建议)
RULES = [
    (r'no manifest fits', 'arch',
     '架构不匹配',
     '镜像没有提供所选平台的 manifest。用 `docker manifest inspect <源镜像>` 查看支持的架构后重新选择。'),
    (r'requested access to the resource is denied|unauthorized|authentication required',
     'denied', '源镜像无法访问（不存在或私有）',
     'Docker/Quay 对「不存在」和「无权限」都返回 denied。请确认地址与 tag 正确；私有镜像需配置源端只读凭证。'),
    (r'manifest unknown|not found|404 page not found',
     'notfound', '镜像或 tag 不存在',
     '检查 tag 是否拼写正确；`docker manifest inspect <源镜像>` 可以快速确认。'),
    (r'no such host|dial tcp|i/o timeout|connection reset|TLS handshake|EOF',
     'network', '网络连接失败',
     '跨境链路抖动。已完成的层会保留，直接重跑会跳过；反复失败可换时段或配源端凭证。'),
    (r'toomanyrequests|429|rate limit',
     'ratelimit', '被源站限流（429）',
     '匿名拉取有配额限制。配置 `SOURCE_DOCKERHUB_USER/PASS` 或 `SOURCE_QUAY_USER/PASS` 可缓解。'),
    (r'dial unix|no space left|permission denied writing',
     'local', '本地环境异常',
     '通常是 runner 磁盘或权限问题，重跑一次；持续出现请检查镜像体积是否超过 runner 磁盘。'),
]


def normalize_source(source):
    """按 Docker 规则把省略的 registry 补全，用于向用户展示"实际会去拉哪个地址"。"""
    s = (source or '').strip()
    if not s:
        return s
    if '@' in s:
        s = s.split('@', 1)[0]
    slash = s.rfind('/')
    colon = s.rfind(':')
    tag = ''
    if colon > slash:
        tag = s[colon + 1:]
        s = s[:colon]
    parts = [p for p in s.split('/') if p]
    if not parts:
        return source
    first = parts[0]
    # 只有存在多个路径段时首段才可能是 registry；单段名字里带点也是镜像名
    has_registry = len(parts) > 1 and ('.' in first or ':' in first or first == 'localhost')
    if has_registry:
        resolved = '/'.join(parts)
    elif len(parts) == 1:
        resolved = 'docker.io/library/' + parts[0]
    else:
        resolved = 'docker.io/' + '/'.join(parts)
    return resolved + (':' + tag if tag else '')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--log', default='syncer.log')
    ap.add_argument('--source', default='')
    ap.add_argument('--arch', default='')
    args = ap.parse_args()

    try:
        with open(args.log, encoding='utf-8', errors='replace') as f:
            text = f.read()
    except OSError:
        text = ''

    cat, title, advice = 'unknown', '同步失败', '请打开本次运行的日志查看 `level=error` 行。'
    for pattern, key, t, a in RULES:
        if re.search(pattern, text, re.I):
            cat, title, advice = key, t, a
            break

    # 取最后一条 error 原文（截断）
    err_lines = [l.strip() for l in text.splitlines() if 'level=error' in l]
    last_err = err_lines[-1] if err_lines else ''
    err_msg = ''
    m = re.search(r'error msg="?([^"]+)"?$', last_err)
    if m:
        err_msg = m.group(1).strip()

    resolved = normalize_source(args.source)
    implicit_registry = bool(resolved) and resolved.startswith('docker.io/') and \
        not re.match(r'^\s*(docker\.io|index\.docker\.io)/', args.source.strip())

    lines = ['### ❌ %s' % title, '']
    lines.append('| 项 | 值 |')
    lines.append('|---|---|')
    lines.append('| 源镜像 | `%s` |' % (args.source or '(未提供)'))
    if args.arch:
        lines.append('| 目标架构 | `%s` |' % args.arch)
    if implicit_registry and resolved:
        lines.append('| 实际拉取地址 | `%s` |' % resolved)
    lines.append('')
    lines.append('**原因**：%s' % advice)

    if implicit_registry and resolved and cat in ('denied', 'notfound'):
        lines.append('')
        lines.append('> ⚠️ 你填的地址没有 registry/命名空间，Docker 规则会按 **`%s`** 解析。'
                     '如果想同步 quay.io 等第三方仓库的镜像，请填写完整地址，'
                     '例如 `quay.io/ascend/cann:8.3.rc1-910b-ubuntu22.04-py3.11`。' % resolved)

    if err_msg:
        lines.append('')
        lines.append('<details><summary>原始错误</summary>')
        lines.append('')
        lines.append('```')
        lines.append(err_msg[:800])
        lines.append('```')
        lines.append('</details>')

    body = '\n'.join(lines)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(body + '\n')

    short = err_msg[:160].replace('\n', ' ') or advice
    print('::error title=%s::%s' % (title, short))
    print(body)
    return 0


if __name__ == '__main__':
    sys.exit(main())