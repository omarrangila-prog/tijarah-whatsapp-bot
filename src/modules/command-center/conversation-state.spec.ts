import { ConversationStatus } from './entities/conversation.entity';
import {
  buildPreview,
  extractVariables,
  interpolate,
  minutesBetween,
  nextStatusOnInbound,
  nextStatusOnOutbound,
  normalizeWaId,
  phoneFromWaId,
  PREVIEW_MAX_LENGTH,
} from './conversation-state';

describe('conversation state machine', () => {
  it('reopens a resolved conversation when the customer writes again', () => {
    expect(nextStatusOnInbound()).toBe(ConversationStatus.OPEN);
  });

  it('moves an open conversation to waiting once an agent replies', () => {
    expect(nextStatusOnOutbound(ConversationStatus.OPEN)).toBe(ConversationStatus.WAITING);
  });

  it('leaves a resolved conversation resolved when an agent sends a courtesy message', () => {
    // Replying inside a resolved thread must not silently reopen it — the agent did not ask to.
    expect(nextStatusOnOutbound(ConversationStatus.RESOLVED)).toBe(ConversationStatus.RESOLVED);
  });

  it('keeps a waiting conversation waiting on a follow-up send', () => {
    expect(nextStatusOnOutbound(ConversationStatus.WAITING)).toBe(ConversationStatus.WAITING);
  });
});

describe('buildPreview', () => {
  it('collapses whitespace in a text message', () => {
    expect(buildPreview('text', '  hello   there \n friend ')).toBe('hello there friend');
  });

  it('labels a location instead of showing its body', () => {
    // A location body is a base64 map thumbnail; rendering it would put kilobytes in the sidebar.
    const thumbnail = 'A'.repeat(5000);
    expect(buildPreview('location', thumbnail)).toBe('📍 Location');
  });

  it('appends a caption for media that can carry one', () => {
    expect(buildPreview('image', 'front of the shirt')).toBe('📷 Photo · front of the shirt');
  });

  it('does not append a caption for media that cannot carry one', () => {
    expect(buildPreview('sticker', 'ignored')).toBe('🌟 Sticker');
  });

  it('truncates a very long body', () => {
    const preview = buildPreview('text', 'x'.repeat(1000));
    expect(preview).toHaveLength(PREVIEW_MAX_LENGTH);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('returns an empty string for an empty TEXT body', () => {
    expect(buildPreview('text', null)).toBe('');
  });

  it('labels an unrecognised type rather than returning nothing', () => {
    // A media kind the engine reports under a name we do not know still carries no body, so
    // falling through would produce an empty preview — and the inbox would then render
    // "No messages yet" over a conversation that had just received a message.
    expect(buildPreview('unknown', '')).toBe('💬 Message');
    expect(buildPreview('protocol', null)).toBe('💬 Message');
  });

  it('labels a voice note, which never carries text', () => {
    expect(buildPreview('voice', '')).toBe('🎤 Voice message');
  });
});

describe('interpolate', () => {
  it('fills known placeholders case-insensitively and tolerates inner spacing', () => {
    expect(interpolate('Hi {{name}}, we have {{ PHONE }}', { name: 'Sana', phone: '923001234567' })).toBe(
      'Hi Sana, we have 923001234567',
    );
  });

  it('leaves an unknown placeholder verbatim rather than blanking it', () => {
    // Sending "your order  ships today" is worse than showing the agent an unresolved token.
    expect(interpolate('Order {{order_id}} ships today', { name: 'Sana' })).toBe('Order {{order_id}} ships today');
  });

  it('treats an empty value as unresolved', () => {
    expect(interpolate('Hi {{name}}', { name: '' })).toBe('Hi {{name}}');
  });

  it('lists every distinct placeholder in order of appearance', () => {
    expect(extractVariables('{{name}} {{Phone}} {{name}} {{agent_name}}')).toEqual(['name', 'phone', 'agent_name']);
  });
});

describe('normalizeWaId', () => {
  it('collapses both user dialects onto one key', () => {
    expect(normalizeWaId('923001234567@s.whatsapp.net')).toBe('923001234567@c.us');
    expect(normalizeWaId('923001234567@c.us')).toBe('923001234567@c.us');
  });

  it('drops a device suffix so one person is one profile', () => {
    expect(normalizeWaId('923001234567:12@s.whatsapp.net')).toBe('923001234567@c.us');
  });

  it('never rewrites a lid into a phone id', () => {
    // A LID's digits are not a phone number; minting one would merge unrelated people.
    expect(normalizeWaId('180927348213@lid')).toBe('180927348213@lid');
  });

  it('leaves group ids alone', () => {
    expect(normalizeWaId('923001234567-1600000000@g.us')).toBe('923001234567-1600000000@g.us');
  });

  it('canonicalises a bare number', () => {
    expect(normalizeWaId('+92 300 1234567')).toBe('923001234567@c.us');
  });
});

describe('phoneFromWaId', () => {
  it('extracts the digits of a user id', () => {
    expect(phoneFromWaId('923001234567@s.whatsapp.net')).toBe('923001234567');
  });

  it('returns null for a non-phone identity', () => {
    expect(phoneFromWaId('180927348213@lid')).toBeNull();
    expect(phoneFromWaId('123-456@g.us')).toBeNull();
  });
});

describe('minutesBetween', () => {
  it('measures a positive span', () => {
    expect(minutesBetween(new Date('2026-01-01T10:00:00Z'), new Date('2026-01-01T10:30:00Z'))).toBe(30);
  });

  it('returns null when either mark is missing', () => {
    expect(minutesBetween(null, new Date())).toBeNull();
    expect(minutesBetween(new Date(), undefined)).toBeNull();
  });

  it('returns null rather than a negative duration for out-of-order marks', () => {
    expect(minutesBetween(new Date('2026-01-02T10:00:00Z'), new Date('2026-01-01T10:00:00Z'))).toBeNull();
  });
});
