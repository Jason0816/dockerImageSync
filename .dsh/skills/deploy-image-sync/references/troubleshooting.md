# Troubleshooting

Each entry is a real failure from this project. Match the exact string before changing anything: several were already fixed, and "fixing" them again in a different way regresses the deployment.

## Deploy / push

**`remote: Permission to ... denied` (403) when pushing**

The fine-grained PAT is missing `Contents: Read and write`. Editing permissions on an existing token takes effect immediately — no need to regenerate.

**`refusing to allow a Personal Access Token to create or update workflow .github/workflows/... without workflow scope`**

Add `Workflows: Read and write` to the same token. This only affects tokens that push workflow files.

**`fatal: could not read Username for 'https://github.com'`**

Non-interactive shell. Either embed the token in the remote URL or use a credential helper; do not wait for a prompt.

**`kex_exchange_identification: Connection closed by remote host` when using SSH**

Network-level interference, not a key problem. If `nslookup github.com` returns an unrelated address (e.g. `28.x.x.x`), the local network rewrites DNS and routes traffic through a transparent proxy. HTTPS with a token is the practical path.

## Workflow

**API `dispatch` returns 422 `Workflow does not have 'workflow_dispatch' trigger`**

The workflow YAML failed to parse, so GitHub indexed the file by path instead of by `name`. Run a YAML parser locally. The known cause: a here-doc body written at column 1 inside a `run: |` block ends the block and breaks the whole document. Use `printf` instead of `cat <<EOF` for generated files.

**Run succeeds but no steps / workflow name shows the file path**

Same root cause as above: invalid YAML. Confirm with `GET /repos/{repo}/actions/workflows`; a healthy entry shows `"name": "Sync Container Images"`.

**Job fails at checkout with a Node 20 deprecation warning**

Only a warning; ignore unless the run itself fails.

## Sync

**`authentication required` / 401 from image-syncer**

`auth.yaml` key does not match the destination hostname, or the SWR login secret is a temporary 24-hour instruction that has expired. Compare the key character by character with the registry host in `images.yaml`.

**`organization not found`**

The SWR organization was never created. Create it in the console first; the API cannot create it for you.

**Sync hangs for tens of minutes, `Run image-syncer` never finishes**

Multi-architecture image plus cross-border upload. `nginx:1.25.3` all-platform is ~93 tasks / ~500 MB; individual layers can stall for tens of minutes after rate limiting. This is why the workflow pins `--arch amd64` and skips the `image-syncer-action` wrapper (that action exposes no arch input). Do not "fix" it by raising timeouts.

**Frequent 429 / slow pulls from Docker Hub**

Anonymous pulls are rate limited per IP, and hosted runners share IPs. Configure `SOURCE_DOCKERHUB_USER` / `SOURCE_DOCKERHUB_PASS` with a read-only Docker Hub token.

**Run succeeds but nothing appears in SWR**

The requested arch is not in the image. image-syncer logs `skip synchronization because no manifest fits` and exits 0. The workflow now detects this and fails the `Run image-syncer` step with an `架构不匹配` annotation; if a deployment still passes silently, its workflow is older than this fix. Verify the source image's platforms before re-running, then switch the arch. (A nonexistent tag fails differently: `generate ... failed` with `n tasks failed`.)

**Container exits with `exec format error`**

Image architecture does not match the host. Re-sync with `arch=arm64` on Kunpeng/Ascend ARM hosts.

**Arch mismatch is a silent no-op in old workflow versions**

Confirmed empirically: an arm64-only source with `arch=amd64` produced `Synchronization finished, 0 tasks failed` and a green run while SWR stayed empty. Do not reintroduce a bare `./image-syncer ...` invocation — keep the `tee syncer.log` capture plus the `no manifest fits` check, and preserve `PIPESTATUS[0]` so genuine failures still fail.

**`Set SWR repositories public` step is red but the image synced**

The step is `continue-on-error: true`. Check `SWR_AK` / `SWR_SK` / `SWR_PROJECT_ID` and that the IAM user has SWR write permission. A missing `SWR_PROJECT_ID` for the target region is the usual cause.

**Setting public has no visible effect**

Visibility is per repository, not per tag, and the switch only *sets* public. Turning the UI toggle off skips the call; it does not make an existing public repository private.

## Worker / UI

**Every API returns `{"error":"服务端未配置访问口令（APP_PASSWORD）"}` (500)**

`APP_PASSWORD` secret is missing. Set it, then reload.

**`{"error":"未登录或登录已过期"}` (401) on every call**

Either the client lost its token, or `APP_PASSWORD` was changed — the token is HMAC-signed with the password, so changing it invalidates every session by design.

**Browser reports `Failed to fetch` with no server log**

The page was opened as a `file://` document, so relative `/api/*` calls have no origin. Serve it over HTTP — `npx wrangler dev` in `worker/` does this locally, and the deployed Worker does it in production.

**Cloudflare returns `error code: 1010`**

The edge blocked the client's User-Agent (typical for `python-urllib`). Not an application bug; use a browser or `curl`.

**`ERR_TUNNEL_CONNECTION_FAILED` in the browser**

A local proxy is configured but its tunnel fails. It is not a DNS or Worker problem. Test with `curl --noproxy '*' https://<worker>/cdn-cgi/trace`.

**Site opens on one machine only**

`*.workers.dev` is commonly unreachable from mainland China. A machine that works is usually going through a proxy or a network that returns fake-IP addresses. Confirm with `nslookup <worker-host>` and `/cdn-cgi/trace`, then use a custom domain or an internal reverse proxy.

**History list appears empty on another device**

By design the history is global (read from GitHub Actions runs), but the *last-run progress restore* is per browser (`localStorage`). An old run without `run-name` has no image title, so it shows no copy button.

## Local preview

**`wrangler dev` starts but `/api/*` returns 500 about `APP_PASSWORD`**

`.dev.vars` is missing or incomplete in `worker/`. It needs `GITHUB_REPO`, `WORKFLOW_ID`, `GITHUB_TOKEN`, and `APP_PASSWORD`.

**`wrangler dev` cannot deploy or list secrets**

`dev` needs no Cloudflare credentials; `deploy` and `secret put` do. Keep `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` only in the shell that runs those two commands.