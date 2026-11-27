# Huawei Cloud SWR details

Three separate credential kinds are involved. Mixing them up is the most common setup failure.

| Credential | Shape | Used for |
|---|---|---|
| Long-term login username/password | `cn-east-4@AKXXXXXXXX` + secret | `docker login` by image-syncer (`auth.yaml`) |
| AK/SK pair | 20-char key + 40-char secret | Calling the SWR REST API to set a repository public |
| Project ID | 32 hex chars, per region | Scoping the AK/SK signature to the right region |

The login credentials **cannot** call the REST API, and AK/SK cannot be used by `docker login`. Both are required.

## Getting each value

- **Organization**: SWR console → 组织管理 → 创建组织. Must exist before the first sync; the API cannot create it implicitly.
- **Long-term login**: SWR console → 系统管理 → 长期有效登录指令 → 生成. Take the username (`<region>@<AK>`) and the secret. Do not use 24-hour temporary instructions — later scheduled syncs fail after expiry.
- **AK/SK**: 我的凭证 → 访问密钥. Prefer a dedicated IAM user (e.g. `image-sync-swr`) over the account's own keys.
- **Project ID**: 我的凭证 → 项目列表 → the row whose `name` equals the target region (e.g. `cn-east-4`).

## IAM permissions

The IAM user needs SWR write access to set repositories public; `SWR FullAccess` is enough. Without it the workflow's last step fails while the image itself still syncs.

A note from real use: with only *some* FunctionGraph policies, read calls succeed while the create call returns `403 APIGW.0302`. That is unrelated to this project, but it is a useful reminder that "reads work" does not prove write permissions.

## Wiring the region in

Two independent places must reference the same registry hostname:

1. `auth.yaml` — the key is the exact hostname:

   ```yaml
   swr.cn-east-4.myhuaweicloud.com:
     username: ${SWR_USERNAME}
     password: ${SWR_PASSWORD}
   docker.io:
     username: ${SOURCE_DOCKERHUB_USER}
     password: ${SOURCE_DOCKERHUB_PASS}
   ```

   No scheme, no path, no trailing slash. image-syncer matches by hostname string, so `swr.cn-north-4...` in the file plus a `cn-east-4` destination fails authentication.

2. The Worker's `SWR_REGISTRY` (default `swr.cn-east-4.myhuaweicloud.com`) and `SWR_ORG` (default `ascend-sync`), which derive the destination address and prefill the UI.

Keep the optional source-credential blocks only if the user syncs private images; delete them otherwise, since empty `${...}` values are harmless but noisy.

## Setting a repository public

`scripts/make_repo_public.py` calls SWR `UpdateRepo`:

```
PUT /v2/manage/namespaces/{namespace}/repos/{repository}
{ "is_public": true }
```

Behavior worth knowing:

- Visibility is **per repository**, not per tag. Setting it once keeps later tags public.
- The script derives the region from the hostname (`swr.<region>.myhuaweicloud.com`), so it follows `SWR_REGISTRY`.
- It exits 0 and prints a skip message when `SWR_AK`/`SWR_SK`/`SWR_PROJECT_ID` are absent, so a deployment without AK/SK still syncs images.
- It only *sets* public. The UI toggle off means "skip", not "make private".
- Dependencies: `pip install huaweicloudsdkcore huaweicloudsdkswr` (the workflow installs them inline).

Public repositories are anonymously pullable by anyone. Confirm with the user before enabling this for internal images.

## Verifying anonymously

Anonymous pull uses the standard Docker Registry flow. Huawei's token realm is region-specific and is advertised by the registry itself — read it from the `WWW-Authenticate` header rather than hardcoding:

```sh
H=https://swr.cn-east-4.myhuaweicloud.com
REALM=$(curl -sS -i "$H/v2/" | tr -d '\r' | grep -io 'realm="[^"]*"' | cut -d'"' -f2)
SERVICE=$(curl -sS -i "$H/v2/" | tr -d '\r' | grep -io 'service="[^"]*"' | cut -d'"' -f2)
TOKEN=$(curl -sS "$REALM?service=$SERVICE&scope=repository:ascend-sync/nginx:pull" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  "$H/v2/ascend-sync/nginx/manifests/1.25.3"
```

`200` means the repository is public. `401` means it is still private (or the token request used the wrong realm/service).

## Region notes

- `cn-east-4` (华东-上海一) is where this project's deployment lives; the defaults assume it.
- Creating FunctionGraph functions via API in `cn-east-4` returned `403 APIGW.0302` while `cn-north-4` worked, so do not treat that region as interchangeable for every service. SWR itself works in `cn-east-4`.
- Dropping a `FunctionGraph`-based replacement for this Worker: FunctionGraph's shared APIG trigger is EOM (end of maintenance), so exposing a public HTTPS endpoint requires a paid dedicated APIG instance. Cloudflare Workers (or another vendor's function URL) remains the pragmatic free option.