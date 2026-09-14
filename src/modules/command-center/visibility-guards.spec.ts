import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ConversationVisibilityGuard } from './conversation-visibility.guard';
import { ChatVisibilityGuard } from './chat-visibility.guard';

const AYESHA = 'agent-ayesha';
const HASSAN = 'agent-hassan';

/** A request context shaped the way Nest hands one to a guard. */
function ctx(request: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function deps(options: {
  privateAssignedChats?: boolean;
  conversation?: { id: string; assigneeId: string | null } | null;
  actor?: { id: string; role: 'admin' | 'operator' | 'viewer' } | null;
}) {
  const findOne = jest.fn().mockResolvedValue(options.conversation ?? null);
  return {
    conversations: { findOne } as never,
    agents: { resolveActor: jest.fn().mockResolvedValue(options.actor ?? null) } as never,
    routing: {
      getSettings: jest.fn().mockResolvedValue({ privateAssignedChats: options.privateAssignedChats ?? true }),
    } as never,
    findOne,
  };
}

describe('ConversationVisibilityGuard', () => {
  const request = (id?: string) => ({ params: id ? { id } : {}, apiKey: { id: 'key-hassan', role: 'operator' } });

  it('allows everything when the fence is off, without even loading the row', async () => {
    const d = deps({ privateAssignedChats: false });
    const guard = new ConversationVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx(request('conv-1')))).resolves.toBe(true);
    expect(d.findOne).not.toHaveBeenCalled();
  });

  it('allows collection routes that carry no conversation id', async () => {
    const d = deps({});
    const guard = new ConversationVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx(request()))).resolves.toBe(true);
  });

  it("hides a colleague's conversation behind a 404", async () => {
    const d = deps({
      conversation: { id: 'conv-1', assigneeId: AYESHA },
      actor: { id: HASSAN, role: 'operator' },
    });
    const guard = new ConversationVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx(request('conv-1')))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('admits an agent to their own conversation', async () => {
    const d = deps({
      conversation: { id: 'conv-1', assigneeId: HASSAN },
      actor: { id: HASSAN, role: 'operator' },
    });
    const guard = new ConversationVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx(request('conv-1')))).resolves.toBe(true);
  });

  it('admits anyone to an unassigned conversation', async () => {
    const d = deps({
      conversation: { id: 'conv-1', assigneeId: null },
      actor: { id: HASSAN, role: 'operator' },
    });
    const guard = new ConversationVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx(request('conv-1')))).resolves.toBe(true);
  });

  it('admits an admin to a conversation owned by someone else', async () => {
    const d = deps({
      conversation: { id: 'conv-1', assigneeId: AYESHA },
      actor: { id: 'agent-admin', role: 'admin' },
    });
    const guard = new ConversationVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx(request('conv-1')))).resolves.toBe(true);
  });

  it('defers to the handler for an id that does not exist, so hidden and missing look alike', async () => {
    const d = deps({ conversation: null, actor: { id: HASSAN, role: 'operator' } });
    const guard = new ConversationVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx(request('conv-nope')))).resolves.toBe(true);
  });
});

describe('ChatVisibilityGuard', () => {
  const base = { params: { sessionId: 'sess-1' }, query: {}, body: {}, apiKey: { id: 'key-hassan', role: 'operator' } };

  it('is inert when the fence is off', async () => {
    const d = deps({ privateAssignedChats: false });
    const guard = new ChatVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx({ ...base, query: { chatId: 'x@c.us' } }))).resolves.toBe(true);
    expect(d.findOne).not.toHaveBeenCalled();
  });

  it("blocks reading a colleague's chat by chatId", async () => {
    const d = deps({
      conversation: { id: 'conv-1', assigneeId: AYESHA },
      actor: { id: HASSAN, role: 'operator' },
    });
    const guard = new ChatVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx({ ...base, query: { chatId: 'ayesha@c.us' } }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('blocks SENDING into a chat the agent cannot see, reading chatId from the body', async () => {
    const d = deps({
      conversation: { id: 'conv-1', assigneeId: AYESHA },
      actor: { id: HASSAN, role: 'operator' },
    });
    const guard = new ChatVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(
      guard.canActivate(ctx({ ...base, body: { chatId: 'ayesha@c.us', text: 'hello' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads chatId from a route param too (history/media routes)', async () => {
    const d = deps({
      conversation: { id: 'conv-1', assigneeId: AYESHA },
      actor: { id: HASSAN, role: 'operator' },
    });
    const guard = new ChatVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(
      guard.canActivate(ctx({ ...base, params: { sessionId: 'sess-1', chatId: 'ayesha@c.us' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses an unfiltered listing of the whole number', async () => {
    const d = deps({ actor: { id: HASSAN, role: 'operator' } });
    const guard = new ChatVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx(base))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an admin list the whole number', async () => {
    const d = deps({ actor: { id: 'agent-admin', role: 'admin' } });
    const guard = new ChatVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx(base))).resolves.toBe(true);
  });

  it('allows a chat that has no conversation row yet — unowned is shared', async () => {
    const d = deps({ conversation: null, actor: { id: HASSAN, role: 'operator' } });
    const guard = new ChatVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx({ ...base, query: { chatId: 'new@c.us' } }))).resolves.toBe(true);
  });

  it('allows an agent their own chat', async () => {
    const d = deps({
      conversation: { id: 'conv-1', assigneeId: HASSAN },
      actor: { id: HASSAN, role: 'operator' },
    });
    const guard = new ChatVisibilityGuard(d.conversations, d.agents, d.routing);
    await expect(guard.canActivate(ctx({ ...base, query: { chatId: 'hassan@c.us' } }))).resolves.toBe(true);
  });
});
