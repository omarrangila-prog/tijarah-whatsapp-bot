import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tag } from './entities/tag.entity';
import { ConversationTag } from './entities/conversation-tag.entity';

/** The workspace tag vocabulary. */
@Injectable()
export class TagService {
  constructor(
    @InjectRepository(Tag, 'data') private readonly tags: Repository<Tag>,
    @InjectRepository(ConversationTag, 'data') private readonly links: Repository<ConversationTag>,
  ) {}

  list(): Promise<Tag[]> {
    return this.tags.find({ order: { name: 'ASC' } });
  }

  async create(name: string, color?: string): Promise<Tag> {
    const trimmed = name.trim();
    const existing = await this.tags.findOne({ where: { name: trimmed } });
    if (existing) throw new ConflictException(`A tag named "${trimmed}" already exists`);
    return this.tags.save(this.tags.create({ name: trimmed, color: color ?? '#6366f1' }));
  }

  /** Get a tag by name, creating it when absent — the path automation takes so a rule that adds an
   *  unknown tag configures itself rather than failing silently. */
  async ensureByName(name: string, color?: string): Promise<Tag> {
    const trimmed = name.trim();
    const existing = await this.tags.findOne({ where: { name: trimmed } });
    if (existing) return existing;
    return this.tags.save(this.tags.create({ name: trimmed, color: color ?? '#6366f1' }));
  }

  async update(id: string, input: { name?: string; color?: string }): Promise<Tag> {
    const tag = await this.tags.findOne({ where: { id } });
    if (!tag) throw new NotFoundException(`Tag ${id} not found`);
    if (input.name !== undefined) tag.name = input.name.trim();
    if (input.color !== undefined) tag.color = input.color;
    return this.tags.save(tag);
  }

  async remove(id: string): Promise<void> {
    const tag = await this.tags.findOne({ where: { id } });
    if (!tag) throw new NotFoundException(`Tag ${id} not found`);
    // Links go with the tag — a dangling link would render as a blank chip on every conversation
    // that carried it.
    await this.links.delete({ tagId: id });
    await this.tags.delete({ id });
  }
}
