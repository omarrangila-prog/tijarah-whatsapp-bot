import { z } from 'zod';

/**
 * What a client's integration actually is: a base URL, an auth scheme, endpoint
 * descriptions and field mappings. Written once per client, stored in the database,
 * validated when it is saved rather than when an invoice fails to go out.
 *
 * Credentials are never in here. `auth.credentialRef` names an environment variable — a
 * config blob holding a live ERP token ends up in a screenshot during setup and in every
 * database backup thereafter.
 */

const fieldPath = z.string().min(1).max(200);
const entityMapping = z.record(z.string().min(1).max(60), fieldPath);

export const endpointSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).default('GET'),
  /** Appended to baseUrl. May contain {{externalId}}, {{asOf}}, {{from}}, {{to}}. */
  path: z.string().min(1).max(500),
  query: z.record(z.string().max(60), z.string().max(200)).optional(),
  headers: z.record(z.string().max(60), z.string().max(300)).optional(),
  /** Where the payload sits in the response. Empty means the response root. */
  resultPath: z.string().max(200).optional(),
});

export const ledgerRestConfigSchema = z.object({
  baseUrl: z.string().url(),
  auth: z
    .object({
      type: z.enum(['none', 'bearer', 'header', 'basic', 'query']).default('none'),
      credentialRef: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{2,63}$/, 'Use the NAME of an environment variable, not the token itself.')
        .optional(),
      parameterName: z.string().max(60).optional(),
      username: z.string().max(120).optional(),
    })
    .default({ type: 'none' }),
  timeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
  maxRetries: z.number().int().min(0).max(5).default(2),

  endpoints: z.object({
    receivables: endpointSchema,
    party: endpointSchema,
    invoices: endpointSchema,
    facts: endpointSchema.optional(),
    contacts: endpointSchema.optional(),
    statement: endpointSchema.optional(),
    invoice: endpointSchema.optional(),
    business: endpointSchema.optional(),
    health: endpointSchema.optional(),
    /*
     * Write endpoints. Their presence is what makes the agent offer the write tools at all —
     * an integration without them is read-only, which is a legitimate and safer setup rather
     * than a broken one.
     */
    createInvoice: endpointSchema.optional(),
    recordPayment: endpointSchema.optional(),
  }),

  mappings: z.object({
    party: entityMapping,
    invoice: entityMapping,
    receivable: entityMapping.optional(),
    facts: entityMapping.optional(),
    contact: entityMapping.optional(),
    entry: entityMapping.optional(),
    business: entityMapping.optional(),
    /** Where the host puts the id/number of something the agent just created. */
    writeResult: entityMapping.optional(),
  }),

  /**
   * How the host's create-invoice body is shaped.
   *
   * Field names differ per system (`customer_id` vs `partner` vs `cust`), so the names are
   * configured rather than assumed. Values are supplied by the agent.
   */
  writeFields: z
    .object({
      invoicePartyField: z.string().max(60).default('customer_id'),
      invoiceDateField: z.string().max(60).default('invoice_date'),
      invoiceDueDateField: z.string().max(60).default('due_date'),
      invoiceLinesField: z.string().max(60).default('lines'),
      invoiceReferenceField: z.string().max(60).default('reference'),
      lineDescriptionField: z.string().max(60).default('description'),
      lineQuantityField: z.string().max(60).default('quantity'),
      linePriceField: z.string().max(60).default('unit_price'),
      paymentPartyField: z.string().max(60).default('customer_id'),
      paymentInvoiceField: z.string().max(60).default('invoice_id'),
      paymentAmountField: z.string().max(60).default('amount'),
      paymentDateField: z.string().max(60).default('paid_on'),
      paymentReferenceField: z.string().max(60).default('reference'),
      /**
       * The header the host reads for idempotency.
       *
       * Sent on every write. If the host honours it, a retried create returns the original
       * invoice; if it does not, the agent's own approval single-use claim is the remaining
       * guard — which is why that claim is a conditional UPDATE rather than a read-then-write.
       */
      idempotencyHeader: z.string().max(60).default('Idempotency-Key'),
    })
    .optional(),

  business: z
    .object({
      name: z.string().min(1).max(200),
      addressLines: z.array(z.string().max(200)).max(4).optional(),
      city: z.string().max(120).optional(),
      phone: z.string().max(40).optional(),
      email: z.string().max(200).optional(),
      taxId: z.string().max(60).optional(),
      currency: z.string().length(3).default('PKR'),
      paymentInstructions: z.string().max(1000).optional(),
    })
    .optional(),

  /**
   * How the host reports what is still owed.
   *
   * `outstanding` — it has a balance-due field. Preferred.
   * `total_minus_paid` — it has only a total and a paid amount, and the agent subtracts.
   *   Offered because many small systems have no balance-due column, but it cannot see
   *   credit notes the host has not already netted off, which the setup screen must say.
   */
  outstandingStrategy: z.enum(['outstanding', 'total_minus_paid']).default('outstanding'),
});

export type LedgerRestConfig = z.infer<typeof ledgerRestConfigSchema>;
export type EndpointConfig = z.infer<typeof endpointSchema>;
