/**
 * Credential resolution for a client's accounting system.
 *
 * The connection config stores the NAME of an environment variable; the value is read from
 * the process environment at call time and never enters the database, an API response or a
 * log line. This agent holds credentials to other people's accounting systems — a config
 * blob containing a live token would be copied into a screenshot during setup and carried
 * in every backup thereafter.
 */

const ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

export function isEnvName(value: string | null | undefined): boolean {
  return typeof value === 'string' && ENV_NAME.test(value);
}

/**
 * Reads a secret by the environment variable named in configuration.
 *
 * A value that does not look like a variable name is ignored rather than used: that shape
 * almost always means someone pasted the token itself into the field, and looking it up
 * would fail anyway. Returns null when absent, so a missing credential degrades the
 * integration rather than crashing the agent.
 */
export function readCredential(ref: string | null | undefined, fallbackName: string): string | null {
  const name = isEnvName(ref) ? (ref as string) : fallbackName;
  const value = process.env[name];
  return value && value.length > 0 ? value : null;
}
