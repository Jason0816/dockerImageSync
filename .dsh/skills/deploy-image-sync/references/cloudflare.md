# Cloudflare deployment details

## What gets deployed

One Worker (`worker/index.js`) serves both:

- `/api/*` — login, config, sync, status, runs
- everything else — the static files from `web/` via `[assets] directory = "../web"`

Same origin means no CORS, no `PROXY_URL` in the frontend, and one deployable unit. Do not split the frontend onto Pages unless the user asks for it: it adds `window.PROXY_URL`, `ALLOWED_ORIGIN`, and a second deploy target for no benefit.

`worker/wrangler.toml` essentials:

```toml
name = "image-sync-proxy"
main = "index.js"
compatibility_date = "2025-06-01"

[assets]
directory = "../web"
```

Static assets require wrangler ≥ 3.78; `npx wrangler@latest` satisfies this. Node.js ≥ 22 is a good baseline.

## Authentication for deployment

```sh
export CLOUDFLARE_API_TOKEN='...'      # Workers Scripts:Edit + Account Settings:Read
export CLOUDFLARE_ACCOUNT_ID='...'     # 32 hex chars, shown on the Workers & Pages page
```

Verify before deploying:

```sh
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts
```

The dashboard's built-in **"Edit Cloudflare Workers"** template includes the needed permission; a custom token needs `Account · Workers Scripts · Edit` and `Account · Account Settings · Read`. Setting a short TTL and revoking after the deploy is good practice.

## Deploy and configure

```sh
cd worker
npx wrangler@latest deploy                       # prints https://<name>.<subdomain>.workers.dev
npx wrangler@latest secret list                  # confirm which secrets exist
```

Secrets (values are never echoed back):

```sh
printf '%s' 'owner/repo'        | npx wrangler@latest secret put GITHUB_REPO
printf '%s' 'sync-images.yml'   | npx wrangler@latest secret put WORKFLOW_ID
printf '%s' '<fine-grained-pat>'| npx wrangler@latest secret put GITHUB_TOKEN
printf '%s' '<access-password>' | npx wrangler@latest secret put APP_PASSWORD
```

Optional non-secret variables belong in `[vars]` inside `wrangler.toml`:

| Variable | Default | Effect |
|---|---|---|
| `SWR_REGISTRY` | `swr.cn-east-4.myhuaweicloud.com` | Registry used to derive destinations and shown in `/api/config` |
| `SWR_ORG` | `ascend-sync` | Default organization and the UI's initial value |
| `ALLOWED_ORIGIN` | `*` | CORS allow-origin; only meaningful if the frontend is served elsewhere |

## Redeploying after code changes

```sh
cd worker && npx wrangler@latest deploy
```

Secrets persist across deploys. Changing `web/` requires a redeploy because the assets are uploaded with the script.

## Custom domain

Workers custom domains require the **zone to be hosted on Cloudflare** (nameservers pointed at Cloudflare). This is a hard requirement and differs from Pages:

- Pages accepts an external DNS provider: add a `CNAME` to `*.pages.dev` at the registrar and enable SSL.
- Workers does not. An `A` record to a Cloudflare edge IP, or a `CNAME` to `*.workers.dev`, returns `Error 1003/1010` because the edge routes by `Host`/SNI and does not know the zone.

Therefore the realistic options are:

1. Move the domain's nameservers to Cloudflare, then add a custom domain on the Worker (free, ~10 minutes, requires recreating existing DNS records).
2. Keep DNS at the registrar and reverse-proxy from a server that has a public IP (nginx `proxy_pass` to the workers.dev host with `proxy_set_header Host` and `proxy_ssl_server_name on`).
3. Internal-only access: reverse-proxy on a LAN host and reach it by LAN address.

Note that a custom domain improves availability in mainland China but does not guarantee it: Cloudflare edge IPs are still subject to interference.

## Cost and limits

The free plan is sufficient: 100k requests/day, static assets are not billed. A single sync costs roughly 9 Worker subrequests (dispatch + run lookup, then polling every 8s) — far below limits.

`wrangler` telemetry and the "new version of npm" notices in output are harmless.

## Verifying a deployment

```sh
BASE=https://<worker-url>
curl -s -o /dev/null -w 'page  %{http_code}\n' "$BASE/"
curl -s -o /dev/null -w 'gate  %{http_code}\n' "$BASE/api/config"    # 401 expected
curl -s -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
     -d '{"password":"<APP_PASSWORD>"}'
```

Then: authenticated `/api/config`, `/api/runs`, and one real sync of `docker.io/library/hello-world:latest`.