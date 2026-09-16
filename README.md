# plac-bootstrap

Standalone internal HTTP service that creates the **first and only** user + workspace
account on this VM's Twenty CRM instance, by driving Twenty's own GraphQL `signUp` /
`signUpInNewWorkspace` mutations. Twenty itself refuses any further account/workspace
creation once one workspace exists (see `IS_MULTIWORKSPACE_ENABLED` in
`/opt/twenty/packages/twenty-server/.env`), so this is meant to be called exactly once,
during provisioning — eventually triggered by the Lovable landing page / a future
control-plane API, never exposed to end users directly.

This is a separate, standalone package from `/opt/twenty` and from `/root/plac-agent`
(the unrelated chat-bridge agent another session is building) — no shared code, ports,
or directories.

## Setup

```bash
cd /root/plac-bootstrap
nvm use 24.16.0
npm install
cp .env.example .env
# edit .env, set BOOTSTRAP_SHARED_SECRET to the output of:
openssl rand -hex 32
```

## Run

```bash
npm run dev     # tsx watch, restarts on file changes
# or
npm run start   # one-shot
```

Listens on `127.0.0.1:4100` only (loopback) — it's an internal endpoint. Exposing it
beyond localhost (e.g. so a real control-plane can reach it during provisioning) is a
deliberate follow-up decision once there's an actual off-box caller, not done here.

## API

`POST /internal/bootstrap`

Headers: `X-Bootstrap-Secret: <BOOTSTRAP_SHARED_SECRET>`

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
`401` bad/missing secret; `400` local validation or rejected by Twenty (weak password,
invalid subdomain, bad email); `409` already bootstrapped or subdomain taken; `502`
Twenty unreachable or an unrecognized upstream error. See `src/index.ts` for the full
mapping — it's driven by exact error-message strings read directly out of Twenty's
`sign-in-up.service.ts` and `subdomain-manager.service.ts`.

Example:
```bash
curl -i -X POST http://127.0.0.1:4100/internal/bootstrap \
  -H "Content-Type: application/json" \
  -H "X-Bootstrap-Secret: $(grep BOOTSTRAP_SHARED_SECRET .env | cut -d= -f2)" \
  -d '{"orgDisplayName":"Acme Inc","subdomain":"acme","adminEmail":"admin@acme.com","adminPassword":"correct-horse-battery"}'
```

## Known test gap

This VM's real Twenty Postgres DB already has an existing workspace (from earlier
manual testing), so the true happy-path (`201 created`) response can only be exercised
against a fresh, scratch Twenty database — not against this VM's live data. What's
verified here is the negative/security path: wrong secret → `401`, invalid body → `400`,
and — the actual property this service exists to prove — a well-formed request against
an already-bootstrapped instance → `409 already_bootstrapped`.

**TODO (follow-up, not done yet):** stand up a scratch Postgres DB + a second Twenty
server process pointed at it (separate `PG_DATABASE_URL`/port) to verify the `201` path
end-to-end before wiring this into real provisioning.

## Future integration

Per the target Plac architecture, a control-plane API would call this endpoint once a
customer's VM agent reports ready during provisioning, using an org-specific secret
injected via cloud-init (a separate secret from the chat-bridge agent's
`AGENT_SHARED_SECRET_SALT`). None of that provisioning/cloud-init wiring exists yet on
this VM — this service only builds the piece that runs *on* the VM.
