import { z } from 'zod';

/**
 * Turns a tool's zod schema into the JSON Schema a model is shown.
 *
 * There is exactly one schema per tool and it already exists — the registry uses it to
 * validate calls. Deriving the model-facing description from that same object rather than
 * writing a second one by hand is what stops the two drifting, which shows up as a model
 * confidently sending arguments the validator then rejects.
 *
 * zod 4 ships `toJSONSchema`, so this is a thin adapter rather than a converter. The work
 * it does is defensive: a schema that cannot be represented (a transform, a refinement with
 * no JSON analogue) throws, and a thrown converter would take down the whole turn rather
 * than one tool. Falling back to a permissive object keeps the rest of the tool list usable
 * and lets the registry's own validation reject a malformed call, which it does anyway.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    const generated = z.toJSONSchema(schema, {
      // Anthropic's tool schema rejects `$ref`/`$defs`; inlining keeps it acceptable.
      io: 'input',
      target: 'draft-7',
      reused: 'inline',
    }) as Record<string, unknown>;

    // A tool schema must be an object at the top level, whatever the zod type says.
    if (generated.type !== 'object') {
      return { type: 'object', properties: {}, additionalProperties: true };
    }
    // `$schema` is noise to a model and is rejected by some tool APIs.
    delete generated.$schema;
    return generated;
  } catch {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
}
