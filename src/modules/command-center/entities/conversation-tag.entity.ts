import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

/** conversation ↔ tag. */
@Entity('cc_conversation_tags')
@Unique('UQ_cc_conversation_tags_pair', ['conversationId', 'tagId'])
@Index('IDX_cc_conversation_tags_conversationId', ['conversationId'])
@Index('IDX_cc_conversation_tags_tagId', ['tagId'])
export class ConversationTag {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  conversationId!: string;

  @Column({ type: 'varchar' })
  tagId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
