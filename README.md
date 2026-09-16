# plac-bootstrap

Standalone internal HTTP service that creates the **first and only** user + workspace
account on this VM's Twenty CRM instance, by driving Twenty's own GraphQL `signUp` /
`signUpInNewWorkspace` mutations. Twenty itself refuses any further account/workspace
creation once one workspace exists (see `IS_MULTIWORKSPACE_ENABLED` in
`/opt/twenty/packages/twenty-server/.env`), so this is meant to be called exactly once,
during provisioning — triggered by the Lovable landing page, never exposed to end users
directly.

This is a separate, standalone package from `/opt/twenty` and from `/root/plac-agent`
(the unrelated chat-bridge agent another session is building) — no shared code, ports,
or directories.

## Setup

```bash
cd /root/plac-bootstrap
nvm use 24.16.0
npm install
cp .env.example .env
# edit .env, set BOOTSTRAP_API_KEY to the output of:
openssl rand -hex 32
```

## Run

```bash
npm run dev     # tsx watch, restarts on file changes
# or
npm run start   # one-shot
```

Listens on `127.0.0.1:4100` only (loopback) — it's never reached directly from the
internet. Public access is via a Cloudflare Tunnel path rule on the existing
`thsbusiness.plac.app` hostname (see below), not a dedicated subdomain — a dedicated
subdomain (`bootstrap.thsbusiness.plac.app`) was tried first but Cloudflare's free
Universal SSL certificate only covers `plac.app` and `*.plac.app` (one level of
wildcard), not a second-level subdomain like that, so the handshake failed at
Cloudflare's edge before ever reaching this VM. Routing through the existing
`thsbusiness.plac.app` hostname sidesteps that entirely, since it's already covered.

## Cloudflare Tunnel setup (manual, one-time)

In the Zero Trust dashboard → Networks → Tunnels → (this VM's tunnel) → Public Hostname
tab, add a **second** Public Hostname entry for the same hostname as the existing Twenty
entry:

- Subdomain: `thsbusiness`
- Domain: `plac.app`
- Path: `plac-bootstrap/internal/bootstrap`
- Service: `HTTP` → `localhost:4100`

Cloudflare Tunnel ingress rules match top-to-bottom and forward the full original
request path unchanged (it does not strip the matched path prefix) — so this rule must
be ordered **above** the existing catch-all rule that forwards everything else to
Twenty, or the catch-all will swallow the request first. Requests to any other path on
`thsbusiness.plac.app` continue to reach Twenty exactly as before.

## API

`GET /plac-bootstrap/ping` — unauthenticated, no side effects, returns
`200 { "status": "ok", "service": "plac-bootstrap" }`. Use this to confirm the
Cloudflare path rule is wired correctly before testing/using the real endpoint below:
```bash
curl https://thsbusiness.plac.app/plac-bootstrap/ping
```

`POST https://thsbusiness.plac.app/plac-bootstrap/internal/bootstrap`
(or `POST http://127.0.0.1:4100/plac-bootstrap/internal/bootstrap` locally on the VM)

Headers: `X-Api-Key: <BOOTSTRAP_API_KEY>`

Body:
```json
{
  "orgDisplayName": "Acme Inc",
  "subdomain": "acme",
  "adminEmail": "admin@acme.com",
  "adminPassword": "correct-horse-battery"
}
```

`subdomain` is optional (Twenty auto-generates one from the email domain if omitted).

Responses: `201` on success with `{ status, workspace: { id, subdomainUrl } }`;
`401` bad/missing API key; `400` local validation or rejected by Twenty (weak password,
invalid subdomain, bad email); `409` already bootstrapped or subdomain taken; `502`
Twenty unreachable or an unrecognized upstream error. See `src/index.ts` for the full
mapping — it's driven by exact error-message strings read directly out of Twenty's
`sign-in-up.service.ts` and `subdomain-manager.service.ts`.

Example (once the Cloudflare path rule above is in place):
```bash
curl -i -X POST https://thsbusiness.plac.app/plac-bootstrap/internal/bootstrap \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <paste the BOOTSTRAP_API_KEY value>" \
  -d '{"orgDisplayName":"Acme Inc","subdomain":"acme","adminEmail":"admin@acme.com","adminPassword":"correct-horse-battery"}'
```

## Known test gap

This VM's real Twenty Postgres DB already has an existing workspace (from earlier
manual testing), so the true happy-path (`201 created`) response can only be exercised
against a fresh, scratch Twenty database — not against this VM's live data. What's
verified here is the negative/security path: wrong API key → `401`, invalid body →
`400`, and — the actual property this service exists to prove — a well-formed request
against an already-bootstrapped instance → `409 already_bootstrapped`.

**TODO (follow-up, not done yet):** stand up a scratch Postgres DB + a second Twenty
server process pointed at it (separate `PG_DATABASE_URL`/port) to verify the `201` path
end-to-end before wiring this into real provisioning.

## Lovable integration

Give Lovable the public URL and API key above (`https://thsbusiness.plac.app/plac-bootstrap/internal/bootstrap`
+ the `BOOTSTRAP_API_KEY` value) to configure as a Supabase Edge Function secret —
never embed the key in client-side/browser code. On org signup, the edge function
should POST the org/admin fields to that URL with the `X-Api-Key` header and store the
returned `workspace.subdomainUrl` against the org record.

This currently targets a single, fixed VM (this one). It doesn't yet generalize to
multiple customer VMs — that needs a per-org URL + API key lookup (an `organizations`
table), which is future work once provisioning is automated, per the target Plac
architecture in `/root/CLAUDE.md`.
