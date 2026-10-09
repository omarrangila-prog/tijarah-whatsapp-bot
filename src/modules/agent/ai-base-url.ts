/**
 * The one `AI_BASE_URL` setting, put in the shape each kind of client expects.
 *
 * Gateways print their address as a bare host ("https://api.openai.fans") and operators paste
 * it as given. OpenAI-style clients then need `/v1` added — without it the gateway answered
 * `POST /chat/completions` with its own web page and a 200, which failed as "Unexpected token <"
 * and left the bot on the rule-based fallback with a working key. Anthropic's SDK adds `/v1`
 * itself, so there the same setting must arrive WITHOUT it, or the request goes to `/v1/v1`.
 * Either spelling of the setting now reaches both.
 */

/** For `/chat/completions` and `/audio/transcriptions`: ends in the version path. */
export function openAiBaseUrl(raw: string | undefined | null): string | null {
  let url = trimmed(raw);
  if (!url) return null;
  // A full endpoint pasted in place of the base.
  url = url.replace(/\/(?:chat\/completions|audio\/transcriptions|messages)$/i, '');
  return hasPath(url) ? url : `${url}/v1`;
}

/** For the Anthropic SDK, which appends `/v1/messages` to whatever it is given. */
export function anthropicBaseUrl(raw: string | undefined | null): string | null {
  const url = trimmed(raw);
  if (!url) return null;
  return url.replace(/\/v1(?:\/messages)?$/i, '') || null;
}

function trimmed(raw: string | undefined | null): string | null {
  const url = String(raw ?? '')
    .trim()
    .replace(/\/+$/, '');
  return url.length > 0 ? url : null;
}

/** Whether the URL already names a path ("/v1", "/openai/v1"), as opposed to a bare host. */
function hasPath(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') !== '';
  } catch {
    // Not a parseable URL; leave it exactly as the operator wrote it.
    return true;
  }
}
