import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QuickReply } from './entities/quick-reply.entity';
import { extractVariables, interpolate } from './conversation-state';

export interface QuickReplyInput {
  shortcut: string;
  title: string;
  body: string;
  folder?: string;
}

/** Saved replies, addressed by `/shortcut` in the composer. */
@Injectable()
export class QuickReplyService {
  constructor(@InjectRepository(QuickReply, 'data') private readonly replies: Repository<QuickReply>) {}

  list(folder?: string): Promise<QuickReply[]> {
    return this.replies.find({
      where: folder ? { folder } : {},
      // Most-used first inside a folder: the composer's `/` picker is a speed tool, so the reply an
      // agent reaches for twenty times a day must not sit below one used once.
      order: { folder: 'ASC', useCount: 'DESC', shortcut: 'ASC' },
    });
  }

  async folders(): Promise<string[]> {
    const rows = await this.replies.find({ select: { folder: true } });
    return [...new Set(rows.map(r => r.folder))].sort((a, b) => a.localeCompare(b));
  }

  async create(input: QuickReplyInput): Promise<QuickReply> {
    const shortcut = normalizeShortcut(input.shortcut);
    const existing = await this.replies.findOne({ where: { shortcut } });
    if (existing) throw new ConflictException(`The shortcut /${shortcut} is already in use`);
    return this.replies.save(
      this.replies.create({
        shortcut,
        title: input.title.trim(),
        body: input.body,
        folder: (input.folder ?? 'General').trim() || 'General',
      }),
    );
  }

  async update(id: string, input: Partial<QuickReplyInput>): Promise<QuickReply> {
    const reply = await this.get(id);
    if (input.shortcut !== undefined) {
      const shortcut = normalizeShortcut(input.shortcut);
      if (shortcut !== reply.shortcut) {
        const clash = await this.replies.findOne({ where: { shortcut } });
        if (clash) throw new ConflictException(`The shortcut /${shortcut} is already in use`);
        reply.shortcut = shortcut;
      }
    }
    if (input.title !== undefined) reply.title = input.title.trim();
    if (input.body !== undefined) reply.body = input.body;
    if (input.folder !== undefined) reply.folder = input.folder.trim() || 'General';
    return this.replies.save(reply);
  }

  async remove(id: string): Promise<void> {
    const result = await this.replies.delete({ id });
    if (!result.affected) throw new NotFoundException(`Quick reply ${id} not found`);
  }

  async get(id: string): Promise<QuickReply> {
    const reply = await this.replies.findOne({ where: { id } });
    if (!reply) throw new NotFoundException(`Quick reply ${id} not found`);
    return reply;
  }

  /**
   * Resolve a reply for one conversation: interpolate its variables and count the use.
   *
   * The counter is incremented here rather than on send because this is the point the agent chose
   * it; whether they then edit the text or abandon the message does not change that they reached
   * for it, which is what "most used" ordering is trying to capture.
   */
  async render(
    id: string,
    variables: Record<string, string | null | undefined>,
  ): Promise<{ reply: QuickReply; text: string; unresolved: string[] }> {
    const reply = await this.get(id);
    const text = interpolate(reply.body, variables);
    const provided = new Set(
      Object.entries(variables)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key]) => key.toLowerCase()),
    );
    const unresolved = extractVariables(reply.body).filter(name => !provided.has(name));
    await this.replies.increment({ id }, 'useCount', 1);
    return { reply, text, unresolved };
  }

  /** Seed a starter set on an empty workspace so the `/` picker is useful on first open. */
  async seedDefaults(): Promise<number> {
    const count = await this.replies.count();
    if (count > 0) return 0;
    const defaults: QuickReplyInput[] = [
      {
        shortcut: 'hello',
        title: 'Greeting',
        folder: 'General',
        body: 'Hi {{name}} 👋 Thanks for reaching out — how can we help today?',
      },
      {
        shortcut: 'price',
        title: 'Pricing',
        folder: 'Sales',
        body: 'Happy to help with pricing, {{name}}. Could you tell me which product or quantity you have in mind so I can send exact numbers?',
      },
      {
        shortcut: 'payment',
        title: 'Payment details',
        folder: 'Sales',
        body: 'You can complete payment via bank transfer or card. Would you like me to send the invoice to this number?',
      },
      {
        shortcut: 'location',
        title: 'Our location',
        folder: 'General',
        body: 'We are open Mon–Sat, 9am–6pm. Would you like me to share our location pin?',
      },
      {
        shortcut: 'thanks',
        title: 'Thanks',
        folder: 'General',
        body: 'Thank you, {{name}}! Let me know if anything else comes up — we are here.',
      },
      {
        shortcut: 'followup',
        title: 'Follow up',
        folder: 'Support',
        body: 'Just following up on this, {{name}} — is there anything still outstanding from our side?',
      },
    ];
    for (const item of defaults) {
      await this.replies.save(this.replies.create({ ...item, folder: item.folder ?? 'General' }));
    }
    return defaults.length;
  }
}

/** Shortcuts are stored bare and lowercase; the composer supplies the `/`. */
export function normalizeShortcut(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);
}
