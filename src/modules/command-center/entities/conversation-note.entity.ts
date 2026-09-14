import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * An INTERNAL note on a conversation.
 *
 * Notes exist only in this database. Nothing in the note path touches an engine send method, and
 * the note controller has no send capability at all — a note can therefore never reach WhatsApp,
 * which is enforced structurally rather than by convention.
 */
@Entity('cc_conversation_notes')
@Index('IDX_cc_conversation_notes_conversationId', ['conversationId'])
export class ConversationNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  conversationId!: string;

  /** `cc_agents.id` of the author, or null when written by a key with no linked agent. */
  @Column({ type: 'varchar', nullable: true })
  authorId!: string | null;

  /** Denormalized author label so a deleted agent doesn't erase the trail. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  authorName!: string | null;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
