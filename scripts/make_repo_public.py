#!/usr/bin/env python3
"""把 SWR 目标仓库设置为公开（幂等，可重复执行）。

用法（workflow 中调用）：
    SWR_AK=... SWR_SK=... SWR_PROJECT_ID=... \
    SWR_DESTINATIONS="swr.cn-east-4.myhuaweicloud.com/ascend-sync/nginx:1.25.3" \
    python3 scripts/make_repo_public.py

说明：
- 可见性按「仓库」生效，不按 tag；设为公开后，后续推新 tag 仍保持公开。
- 未配置凭证时只打印提示并退出 0，不影响镜像同步本身。
- 目标仓库不存在（例如镜像同步失败）时该仓库标记失败，其余继续。
"""

import os
import sys


def parse_destination(dest):
    """解析 swr.<region>.myhuaweicloud.com/<namespace>/<repo>[:tag]"""
    value = dest.split('@')[0].strip()
    slash = value.rfind('/')
    colon = value.rfind(':')
    if colon > slash:
        value = value[:colon]

    parts = [p for p in value.split('/') if p]
    if len(parts) < 3:
        raise ValueError(f'无法解析目标地址: {dest}')

    host = parts[0]
    namespace = parts[1]
    repository = parts[2]

    labels = host.split('.')
    region = labels[1] if len(labels) >= 3 and labels[0] == 'swr' else 'cn-east-4'
    return host, region, namespace, repository


def main():
    ak = os.environ.get('SWR_AK', '').strip()
    sk = os.environ.get('SWR_SK', '').strip()
    project_id = os.environ.get('SWR_PROJECT_ID', '').strip()
    raw = os.environ.get('SWR_DESTINATIONS', '')

    destinations = [d.strip() for d in raw.split(',') if d.strip()]

    if not (ak and sk and project_id):
        print('未配置 SWR_AK / SWR_SK / SWR_PROJECT_ID，跳过「设为公开」步骤')
        return 0
    if not destinations:
        print('没有目标地址，跳过「设为公开」步骤')
        return 0

    try:
        from huaweicloudsdkcore.auth.credentials import BasicCredentials
        from huaweicloudsdkswr.v2 import SwrClient, UpdateRepoRequest, UpdateRepoRequestBody
        from huaweicloudsdkswr.v2.region.swr_region import SwrRegion
    except ImportError as exc:
        print(f'华为云 SDK 未安装: {exc}')
        return 2

    failed = 0
    for dest in destinations:
        try:
            host, region, namespace, repository = parse_destination(dest)
        except ValueError as exc:
            print(f'SKIP {dest}: {exc}')
            failed += 1
            continue

        try:
            credentials = BasicCredentials(ak, sk, project_id)
            client = (
                SwrClient.new_builder()
                .with_credentials(credentials)
                .with_region(SwrRegion.value_of(region))
                .build()
            )
            request = UpdateRepoRequest(
                namespace=namespace,
                repository=repository,
                body=UpdateRepoRequestBody(is_public=True),
            )
            client.update_repo(request)
            print(f'OK   {host}/{namespace}/{repository} -> is_public=true')
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f'FAIL {host}/{namespace}/{repository}: {exc}')

    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
