// Talks to the Bridge console: GitHub Actions OIDC identity, the just-in-time
// GitHub token broker, and run-report upload. Nothing here runs package code.

const DEFAULT_TIMEOUT_MS = 15000;

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function resolveCloudSettings(env = process.env) {
  const apiUrl = trimSlash(env.BRIDGE_API_URL);
  let audience = String(env.BRIDGE_OIDC_AUDIENCE || '').trim();

  if (!audience && apiUrl) {
    try {
      audience = new URL(apiUrl).origin;
    } catch {
      audience = '';
    }
  }

  return {
    apiUrl,
    consoleUrl: trimSlash(env.BRIDGE_CONSOLE_URL) || apiUrl,
    apiToken: String(env.BRIDGE_API_TOKEN || '').trim(),
    githubToken: String(env.BRIDGE_GITHUB_TOKEN || '').trim(),
    audience,
    oidcAvailable: Boolean(
      String(env.ACTIONS_ID_TOKEN_REQUEST_URL || '').trim() &&
        String(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || '').trim()
    ),
    env
  };
}

export function describeCiEnvironment(env = process.env) {
  if (String(env.GITHUB_ACTIONS || '') !== 'true') {
    return { provider: 'local' };
  }

  const server = trimSlash(env.GITHUB_SERVER_URL) || 'https://github.com';
  const repository = String(env.GITHUB_REPOSITORY || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();

  return {
    provider: 'github-actions',
    repository,
    runId,
    runAttempt: String(env.GITHUB_RUN_ATTEMPT || '').trim(),
    runUrl: repository && runId ? `${server}/${repository}/actions/runs/${runId}` : '',
    workflow: String(env.GITHUB_WORKFLOW || '').trim(),
    workflowRef: String(env.GITHUB_WORKFLOW_REF || '').trim(),
    event: String(env.GITHUB_EVENT_NAME || '').trim(),
    actor: String(env.GITHUB_ACTOR || '').trim()
  };
}

export function runUrlFor(settings, runId) {
  const base = settings?.consoleUrl || settings?.apiUrl;
  return base && runId ? `${base}/runs/${encodeURIComponent(runId)}` : '';
}

export class CloudError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
  }
}

async function readError(response) {
  try {
    const body = await response.json();
    return body?.error || body?.message || '';
  } catch {
    return '';
  }
}

export async function requestActionsOidcToken({
  audience,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const requestUrl = String(env.ACTIONS_ID_TOKEN_REQUEST_URL || '').trim();
  const requestToken = String(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || '').trim();

  if (!requestUrl || !requestToken) {
    throw new CloudError(
      'GitHub Actions OIDC is not available. Grant the job `permissions: id-token: write`.'
    );
  }

  const url = new URL(requestUrl);

  if (audience) {
    url.searchParams.set('audience', audience);
  }

  const response = await fetchImpl(url, {
    headers: { authorization: `bearer ${requestToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new CloudError(`GitHub refused the OIDC token request (HTTP ${response.status}).`, {
      status: response.status
    });
  }

  const body = await response.json();

  if (!body?.value) {
    throw new CloudError('GitHub returned an empty OIDC token.');
  }

  return body.value;
}

export async function cloudAuthorization(settings, { fetchImpl = globalThis.fetch } = {}) {
  if (settings.apiToken) {
    return `Bearer ${settings.apiToken}`;
  }

  if (settings.oidcAvailable) {
    const token = await requestActionsOidcToken({
      audience: settings.audience,
      env: settings.env,
      fetchImpl
    });
    return `Bearer ${token}`;
  }

  return '';
}

/**
 * Returns a short-lived GitHub token for pushing the Bridge branch and opening the PR.
 * Order: an explicit BRIDGE_GITHUB_TOKEN, else the console's token broker via OIDC.
 */
export async function obtainGitHubToken(
  settings,
  { repository = '', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  if (settings.githubToken) {
    return {
      token: settings.githubToken,
      source: 'BRIDGE_GITHUB_TOKEN',
      expiresAt: '',
      commitAuthor: null
    };
  }

  if (!settings.apiUrl) {
    throw new CloudError(
      'No GitHub credentials for publishing. Set BRIDGE_API_URL (Bridge GitHub App) or BRIDGE_GITHUB_TOKEN.'
    );
  }

  if (!settings.oidcAvailable) {
    throw new CloudError(
      'The Bridge token broker needs GitHub Actions OIDC. Grant the publish job `permissions: id-token: write`, or set BRIDGE_GITHUB_TOKEN.'
    );
  }

  const oidcToken = await requestActionsOidcToken({
    audience: settings.audience,
    env: settings.env,
    fetchImpl
  });
  const response = await fetchImpl(`${settings.apiUrl}/api/v1/github/token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${oidcToken}`,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({ repository }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const detail = await readError(response);
    throw new CloudError(
      `Bridge token broker refused (HTTP ${response.status})${detail ? `: ${detail}` : ''}.`,
      { status: response.status }
    );
  }

  const body = await response.json();

  if (!body?.token) {
    throw new CloudError('Bridge token broker returned no token.');
  }

  return {
    token: body.token,
    source: 'broker',
    expiresAt: body.expiresAt || '',
    commitAuthor: body.commitAuthor || null,
    repository: body.repository || repository
  };
}

export async function uploadRunReport(
  settings,
  report,
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  if (!settings.apiUrl) {
    return { status: 'skipped', url: '', message: 'BRIDGE_API_URL is not set.' };
  }

  let authorization = '';

  try {
    authorization = await cloudAuthorization(settings, { fetchImpl });
  } catch (authError) {
    return { status: 'failed', url: '', message: authError.message };
  }

  if (!authorization) {
    return {
      status: 'skipped',
      url: '',
      message: 'No Bridge credentials (set BRIDGE_API_TOKEN, or run in GitHub Actions with id-token: write).'
    };
  }

  try {
    const response = await fetchImpl(`${settings.apiUrl}/api/v1/runs`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ report }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      const detail = await readError(response);
      return {
        status: 'failed',
        url: '',
        message: `Bridge console refused the run report (HTTP ${response.status})${detail ? `: ${detail}` : ''}.`
      };
    }

    const body = await response.json().catch(() => ({}));
    return {
      status: 'uploaded',
      url: body?.url || runUrlFor(settings, report?.run?.id),
      message: 'Run report uploaded to Bridge.'
    };
  } catch (uploadError) {
    return {
      status: 'failed',
      url: '',
      message: `Could not reach the Bridge console: ${uploadError?.message || uploadError}`
    };
  }
}
