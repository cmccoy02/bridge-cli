const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const SENSITIVE_ASSIGNMENT =
  /\b(token|password|passwd|secret|api[_-]?key|auth(?:orization)?)\s*([=:])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_TOKEN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const NPM_TOKEN = /(\/\/[^/\s]+\/[^:\s]*:_authToken=)[^\s]+/gi;

export function redactSensitiveText(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return String(value)
    .replace(URL_CREDENTIALS, '$1[redacted]:[redacted]@')
    .replace(BEARER_TOKEN, '$1 [redacted]')
    .replace(SENSITIVE_ASSIGNMENT, '$1$2[redacted]')
    .replace(NPM_TOKEN, '$1[redacted]');
}

export function redactActivityPayload(value) {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactActivityPayload(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactActivityPayload(entry)])
    );
  }

  return value;
}
