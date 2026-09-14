import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConversationNote } from './entities/conversation-note.entity';

/**
 * Internal notes.
 *
 * This service has no dependency on any send path, engine or message service — it can write to the
 * notes table and nothing else. That is the structural guarantee behind "notes are never sent to
 * WhatsApp": there is no code path from here to a send, not merely a convention against one.
 */
@Injectable()
export class NoteService {
  constructor(@InjectRepository(ConversationNote, 'data') private readonly notes: Repository<ConversationNote>) {}

  list(conversationId: string): Promise<ConversationNote[]> {
    return this.notes.find({ where: { conversationId }, order: { createdAt: 'DESC' }, take: 200 });
  }

  create(conversationId: string, body: string, author: { id?: string | null; name?: string | null }) {
    return this.notes.save(
      this.notes.create({
        conversationId,
        body: body.trim(),
        authorId: author.id ?? null,
        authorName: author.name ?? null,
      }),
    );
  }

  async update(id: string, body: string): Promise<ConversationNote> {
    const note = await this.notes.findOne({ where: { id } });
    if (!note) throw new NotFoundException(`Note ${id} not found`);
    note.body = body.trim();
    return this.notes.save(note);
  }

  async remove(id: string): Promise<void> {
    const result = await this.notes.delete({ id });
    if (!result.affected) throw new NotFoundException(`Note ${id} not found`);
  }
}
