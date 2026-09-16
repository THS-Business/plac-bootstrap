import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

process.loadEnvFile();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

const PORT = Number(process.env.PORT ?? '4100');
// Auth mutations (signUp, signUpInNewWorkspace, ...) live on Twenty's "metadata"-scoped
// GraphQL schema, mounted at /metadata — NOT the main /graphql endpoint, which only
// serves workspace-data resolvers (confirmed via schema introspection on this VM).
const TWENTY_GRAPHQL_URL = requireEnv('TWENTY_GRAPHQL_URL');
const BOOTSTRAP_API_KEY = requireEnv('BOOTSTRAP_API_KEY');

// Cloudflare Tunnel forwards the full original path unchanged (it does not strip a
// matched path prefix), so this must match exactly what the Public Hostname path rule
// for thsbusiness.plac.app is configured to forward here. See README for the exact
// Cloudflare Zero Trust dashboard setup.
const BOOTSTRAP_PATH = '/plac-bootstrap/internal/bootstrap';
// Unauthenticated on purpose (standard for a health check) — reveals only that the
// service is up, nothing sensitive, so it's safe to leave open on the public hostname.
const PING_PATH = '/plac-bootstrap/ping';

// ---------------------------------------------------------------------------
// Twenty GraphQL contract
//
// Confirmed by reading /opt/twenty/packages/twenty-server/src/engine/core-modules/auth
// (auth.resolver.ts, services/sign-in-up.service.ts) directly. Do not modify Twenty's
// source to "fix" a mismatch here — if these ever drift, re-read that source first.
// ---------------------------------------------------------------------------

const SIGN_UP_MUTATION = `
  mutation SignUp($email: String!, $password: String!) {
    signUp(email: $email, password: $password) {
      tokens {
        accessOrWorkspaceAgnosticToken {
          token
        }
      }
    }
  }
`;

const SIGN_UP_IN_NEW_WORKSPACE_MUTATION = `
  mutation SignUpInNewWorkspace($input: SignUpInNewWorkspaceInput) {
    signUpInNewWorkspace(input: $input) {
      workspace {
        id
        workspaceUrls {
          subdomainUrl
          customUrl
        }
      }
    }
  }
`;

interface GraphQlError {
  message: string;
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: GraphQlError[];
}

interface SignUpData {
  signUp: {
    tokens: {
      accessOrWorkspaceAgnosticToken: {
        token: string;
      };
    };
  };
}

interface SignUpInNewWorkspaceData {
  signUpInNewWorkspace: {
    workspace: {
      id: string;
      workspaceUrls: {
        subdomainUrl: string;
        customUrl: string | null;
      };
    };
  };
}

async function callTwentyGraphQl<T>(
  query: string,
  variables: Record<string, unknown>,
  bearerToken?: string,
): Promise<GraphQlResponse<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }

  const response = await fetch(TWENTY_GRAPHQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  return (await response.json()) as GraphQlResponse<T>;
}

// ---------------------------------------------------------------------------
// Error mapping
//
// Twenty returns GraphQL errors as HTTP 200 + body.errors, so we match on the
// error message text rather than HTTP status. Strings verified against the
// live source (see plan doc) — anything unrecognized falls through to a safe
// generic 502 rather than being silently swallowed.
// ---------------------------------------------------------------------------

type ErrorCode =
  | 'already_bootstrapped'
  | 'subdomain_taken'
  | 'subdomain_invalid'
  | 'rejected_by_twenty'
  | 'upstream_error';

interface MatchedError {
  status: number;
  code: ErrorCode;
  message: string;
}

const ERROR_MATCHERS: { test: (msg: string) => boolean; status: number; code: ErrorCode }[] = [
  { test: (m) => m.includes('new workspace setup is disabled'), status: 409, code: 'already_bootstrapped' },
  { test: (m) => m.includes('subdomain already taken'), status: 409, code: 'subdomain_taken' },
  { test: (m) => m.includes('subdomain is not valid'), status: 400, code: 'subdomain_invalid' },
  { test: (m) => m.includes('password too weak'), status: 400, code: 'rejected_by_twenty' },
  { test: (m) => m.includes('workspace name is required'), status: 400, code: 'rejected_by_twenty' },
  { test: (m) => m.includes('user already exists'), status: 400, code: 'rejected_by_twenty' },
  { test: (m) => m.includes('email'), status: 400, code: 'rejected_by_twenty' },
];

function matchTwentyError(errors: GraphQlError[]): MatchedError {
  const first = errors[0];
  const rawMessage = first?.message ?? 'Unknown error from Twenty';
  const lower = rawMessage.toLowerCase();

  for (const matcher of ERROR_MATCHERS) {
    if (matcher.test(lower)) {
      return { status: matcher.status, code: matcher.code, message: rawMessage };
    }
  }

  return { status: 502, code: 'upstream_error', message: rawMessage };
}

// ---------------------------------------------------------------------------
// Bootstrap orchestration
// ---------------------------------------------------------------------------

interface BootstrapInput {
  orgDisplayName: string;
  subdomain?: string;
  adminEmail: string;
  adminPassword: string;
}

interface BootstrapSuccess {
  ok: true;
  workspaceId: string;
  subdomainUrl: string;
}

interface BootstrapFailure {
  ok: false;
  status: number;
  code: ErrorCode | 'upstream_unavailable';
  message: string;
}

type BootstrapResult = BootstrapSuccess | BootstrapFailure;

async function bootstrapWorkspace(input: BootstrapInput): Promise<BootstrapResult> {
  let signUpResponse: GraphQlResponse<SignUpData>;
  try {
    signUpResponse = await callTwentyGraphQl<SignUpData>(SIGN_UP_MUTATION, {
      email: input.adminEmail,
      password: input.adminPassword,
    });
  } catch (error) {
    return { ok: false, status: 502, code: 'upstream_unavailable', message: `Could not reach Twenty: ${(error as Error).message}` };
  }

  if (signUpResponse.errors && signUpResponse.errors.length > 0) {
    const matched = matchTwentyError(signUpResponse.errors);
    return { ok: false, status: matched.status, code: matched.code, message: matched.message };
  }

  const accessToken = signUpResponse.data?.signUp.tokens.accessOrWorkspaceAgnosticToken.token;
  if (!accessToken) {
    return { ok: false, status: 502, code: 'upstream_unavailable', message: 'Twenty signUp response missing access token' };
  }

  const workspaceInput: Record<string, unknown> = { displayName: input.orgDisplayName };
  if (input.subdomain) {
    workspaceInput.subdomain = input.subdomain;
  }

  let signUpInWorkspaceResponse: GraphQlResponse<SignUpInNewWorkspaceData>;
  try {
    signUpInWorkspaceResponse = await callTwentyGraphQl<SignUpInNewWorkspaceData>(
      SIGN_UP_IN_NEW_WORKSPACE_MUTATION,
      { input: workspaceInput },
      accessToken,
    );
  } catch (error) {
    return { ok: false, status: 502, code: 'upstream_unavailable', message: `Could not reach Twenty: ${(error as Error).message}` };
  }

  if (signUpInWorkspaceResponse.errors && signUpInWorkspaceResponse.errors.length > 0) {
    const matched = matchTwentyError(signUpInWorkspaceResponse.errors);
    return { ok: false, status: matched.status, code: matched.code, message: matched.message };
  }

  const workspace = signUpInWorkspaceResponse.data?.signUpInNewWorkspace.workspace;
  if (!workspace) {
    return { ok: false, status: 502, code: 'upstream_unavailable', message: 'Twenty signUpInNewWorkspace response missing workspace' };
  }

  return { ok: true, workspaceId: workspace.id, subdomainUrl: workspace.workspaceUrls.subdomainUrl };
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

const SUBDOMAIN_PATTERN = /^(?!api-)[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const PASSWORD_PATTERN = /^.{8,50}$/;

function validateRequestBody(body: unknown): { ok: true; value: BootstrapInput } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Request body must be a JSON object' };
  }

  const b = body as Record<string, unknown>;

  const orgDisplayName = b.orgDisplayName;
  if (typeof orgDisplayName !== 'string' || orgDisplayName.trim().length === 0 || orgDisplayName.length > 100) {
    return { ok: false, message: 'orgDisplayName is required and must be 1-100 characters' };
  }

  const adminEmail = b.adminEmail;
  if (typeof adminEmail !== 'string' || !adminEmail.includes('@')) {
    return { ok: false, message: 'adminEmail is required and must look like an email address' };
  }

  const adminPassword = b.adminPassword;
  if (typeof adminPassword !== 'string' || !PASSWORD_PATTERN.test(adminPassword)) {
    return { ok: false, message: 'adminPassword is required and must be 8-50 characters' };
  }

  let subdomain: string | undefined;
  if (b.subdomain !== undefined) {
    if (typeof b.subdomain !== 'string' || !SUBDOMAIN_PATTERN.test(b.subdomain)) {
      return { ok: false, message: 'subdomain, if provided, must be 1-30 lowercase alphanumeric/hyphen characters' };
    }
    subdomain = b.subdomain;
  }

  return { ok: true, value: { orgDisplayName, adminEmail, adminPassword, subdomain } };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function isAuthorized(req: IncomingMessage): boolean {
  const provided = req.headers['x-api-key'];
  if (typeof provided !== 'string') {
    return false;
  }

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(BOOTSTRAP_API_KEY);

  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(providedBuf, expectedBuf);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) {
    return {};
  }
  return JSON.parse(raw);
}

function redactBody(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return { ...(value as Record<string, unknown>), adminPassword: '[redacted]' };
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    console.error('Unhandled error', error);
    sendJson(res, 500, { error: 'internal_error' });
  });
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === PING_PATH) {
    sendJson(res, 200, { status: 'ok', service: 'plac-bootstrap' });
    return;
  }

  if (req.method !== 'POST' || req.url !== BOOTSTRAP_PATH) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  if (!isAuthorized(req)) {
    console.log(JSON.stringify({ path: req.url, status: 401 }));
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_request', message: 'Request body must be valid JSON' });
    return;
  }

  const validation = validateRequestBody(body);
  if (!validation.ok) {
    console.log(JSON.stringify({ path: req.url, status: 400, body: redactBody(body) }));
    sendJson(res, 400, { error: 'validation_failed', message: validation.message });
    return;
  }

  const result = await bootstrapWorkspace(validation.value);

  if (result.ok) {
    console.log(JSON.stringify({ path: req.url, status: 201, body: redactBody(body) }));
    sendJson(res, 201, {
      status: 'created',
      workspace: { id: result.workspaceId, subdomainUrl: result.subdomainUrl },
    });
    return;
  }

  console.log(JSON.stringify({ path: req.url, status: result.status, code: result.code, body: redactBody(body) }));
  sendJson(res, result.status, { error: result.code, message: result.message });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`plac-bootstrap listening on http://127.0.0.1:${PORT}`);
});
