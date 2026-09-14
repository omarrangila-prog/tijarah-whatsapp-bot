/**
 * Resolves a named authentication profile into request headers.
 *
 * The registry stores only a profile NAME; the secret lives in the environment as
 * `DOCAPI_<PROFILE>_TOKEN` (bearer) or `DOCAPI_<PROFILE>_APIKEY` (header key). That
 * separation is the whole point: a document-type row, a job row and every log line can be
 * read by anyone with operator access, and none of them ever contain a credential.
 *
 * An unknown or unset profile returns no headers rather than throwing, so a misconfigured
 * profile fails as an authentication error from the API — visible, attributable and safe —
 * instead of as a crash inside the worker.
 */
export function resolveAuthProfile(profile: string | null | undefined): Record<string, string> {
  if (!profile || !profile.trim()) return {};
  const slug = profile
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');

  const bearer = process.env[`DOCAPI_${slug}_TOKEN`];
  if (bearer) return { authorization: `Bearer ${bearer}` };

  const apiKey = process.env[`DOCAPI_${slug}_APIKEY`];
  if (apiKey) {
    const header = process.env[`DOCAPI_${slug}_HEADER`] ?? 'x-api-key';
    return { [header.toLowerCase()]: apiKey };
  }
  return {};
}

/** Header names whose values must never appear in a log or an error message. */
export const REDACTED_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'proxy-authorization']);

/** A copy of the headers safe to log: names kept, secret values replaced. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      REDACTED_HEADERS.has(key.toLowerCase()) ? '<redacted>' : value,
    ]),
  );
}
