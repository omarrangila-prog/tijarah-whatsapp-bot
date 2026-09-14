import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * Which API produces which document, and what a valid answer from it looks like.
 *
 * This is configuration rather than code so that adding a document type is an operations
 * task, not a deployment: a new type is a row. The §13 Google Sheet import maps onto these
 * columns one-for-one.
 *
 * **No credential is ever stored here.** `authProfile` names an environment-backed profile;
 * the secret itself is resolved at call time and never written to a row, a log or a job.
 * A registry that held its own keys would put every API secret one SELECT away from anyone
 * who could read the jobs screen.
 */
@Entity('document_type_registry')
@Index('IDX_dtr_type', ['documentType'], { unique: true })
export class DocumentTypeRegistry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  documentType!: string;

  @Column({ type: 'varchar', length: 190 })
  displayName!: string;

  /** May contain `{placeholders}` filled from the job's parameters. */
  @Column({ type: 'text' })
  endpoint!: string;

  @Column({ type: 'varchar', length: 10, default: 'GET' })
  method!: string;

  /** The NAME of an auth profile, never a secret. Resolved from env at call time. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  authProfile!: string | null;

  @Column({ type: jsonColumnType(), nullable: true })
  requiredParameters!: string[] | null;

  @Column({ type: jsonColumnType(), nullable: true })
  optionalParameters!: string[] | null;

  /**
   * Values merged under every job's own parameters.
   *
   * A host system's endpoint usually carries more path segments than a caller should have to
   * know: a company id, a branch code, a fiscal year, a screen code. Those belong to the
   * integration, not to the request, so they live here and a job carries only what genuinely
   * varies — the document number. A job that does supply one of them overrides it, which is
   * what makes a second company or a prior year possible without a second registry row.
   */
  @Column({ type: jsonColumnType(), nullable: true })
  defaultParameters!: Record<string, unknown> | null;

  /** Non-secret headers only. Anything sensitive belongs to the auth profile. */
  @Column({ type: jsonColumnType(), nullable: true })
  requestHeaders!: Record<string, string> | null;

  /** Maps job parameter names onto the API's body field names. */
  @Column({ type: jsonColumnType(), nullable: true })
  requestBodyMapping!: Record<string, string> | null;

  /**
   * How the document is obtained: `http` fetches an API response, `browser` drives a signed-in
   * Chrome for a host that renders its PDFs client-side.
   */
  @Column({ type: 'varchar', length: 16, default: 'http' })
  providerKind!: string;

  /** `binary` | `url` | `base64` | `json` — meaningful only for `http`. */
  @Column({ type: 'varchar', length: 16, default: 'binary' })
  responseFormat!: string;

  /**
   * For `json` responses: dotted paths to the document and its filename.
   * e.g. `data.pdfUrl`, or `result.content` for base64.
   */
  @Column({ type: jsonColumnType(), nullable: true })
  responseParser!: { documentPath?: string; filenamePath?: string; mimeTypePath?: string } | null;

  @Column({ type: 'varchar', length: 120, default: 'application/pdf' })
  expectedMimeType!: string;

  @Column({ type: 'int', default: 10_485_760 })
  maximumFileSize!: number;

  /**
   * The note a recipient reads above the document.
   *
   * Placeholders: `{displayName}` `{documentNumber}` `{reference}` `{greeting}` `{period}`
   * `{businessName}`. A line whose placeholders all resolve to nothing is dropped, so a
   * contact with no name on file never receives "Dear ,".
   *
   * NULL uses the default for the document's kind — see caption.ts.
   */
  @Column({ type: 'text', nullable: true })
  captionTemplate!: string | null;

  /** A template such as `{documentReference}.pdf`. */
  @Column({ type: 'varchar', length: 190, default: '{documentReference}.pdf' })
  filenameRule!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /**
   * Whether an authorised person may ask for this in a WhatsApp conversation.
   *
   * True for reports, which belong to the business. False for anything belonging to a named
   * customer — an invoice requested by name is how one customer's document reaches another.
   */
  @Column({ type: 'boolean', default: false })
  chatRequestable!: boolean;

  /** Targets the KPI screen measures against: seconds, and a percentage. */
  @Column({ type: 'int', default: 20 })
  targetProcessingSeconds!: number;

  @Column({ type: 'int', default: 99 })
  targetSuccessRate!: number;

  @Column({ type: 'int', default: 3 })
  maximumAttempts!: number;

  @Column({ type: 'int', default: 30 })
  timeoutSeconds!: number;

  /**
   * How many duplicate job requests the idempotency key has turned away.
   *
   * Counted here rather than derived, because a prevented duplicate leaves no job row behind —
   * that is the entire point of it. Without a counter this KPI could only ever be reported as
   * zero, which would quietly claim the guard had never done anything.
   */
  @Column({ type: 'int', default: 0 })
  duplicatesPrevented!: number;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  createdAt!: Date;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  updatedAt!: Date;
}
