import { isRomanUrdu, isYes, rootMenu, smallTalk } from './client-menu';

/** Conversation from the live chats, answered briefly in the client's language. */
describe('small talk', () => {
  it.each([
    ['Salamalykum', 'Wa alaikum assalam!'],
    ['assalam o alaikum', 'Wa alaikum assalam!'],
    ['AOA bhai', 'Wa alaikum assalam!'],
    ['kya haal hai', 'Alhamdulillah, theek hoon! Bataiye kya chahiye:'],
    ['1,2,3,4,5', 'Please send one number at a time:'],
  ])('%s opens the menu with "%s"', (text, greeting) => {
    expect(smallTalk(text)).toMatchObject({ kind: 'menu', greeting });
  });

  it.each(['menu dikhao', 'kya kar sakte ho', 'what can you do', '?', 'Send me the docs', 'documents bhejo'])(
    '%s opens the menu',
    text => {
      expect(smallTalk(text)).toMatchObject({ kind: 'menu' });
    },
  );

  it.each(['mujhe report chahiye', 'koi report bhejo', 'reports', 'send me reports'])(
    '%s opens the report list',
    text => {
      expect(smallTalk(text)).toEqual({ kind: 'reports' });
    },
  );

  it.each([
    ['shukriya', 'Aap ka bhi shukriya!'],
    ['jazakallah bhai', 'Aap ka bhi shukriya!'],
    ['thanks', "You're welcome!"],
    ['haan bhai', 'Ji!'],
    ['theek hai', 'Ji!'],
    ['ok', 'Okay!'],
    ['chal bsdk', 'Main aap ki madad ke liye hoon.'],
  ])('%s is answered briefly', (text, start) => {
    const talk = smallTalk(text);
    expect(talk?.kind).toBe('say');
    expect(talk && 'text' in talk ? talk.text : '').toMatch(new RegExp(`^${start.replace(/[!?.]/g, '\\$&')}`));
  });

  it.each([
    'Danyal ka ledger',
    'trial balance',
    'sale invoice 179',
    '4',
    'last 30 days',
    'ok send danyal ledger',
    'report of danyal',
  ])('leaves a real request (%s) to be read as one', text => {
    expect(smallTalk(text)).toBeNull();
  });
});

describe('the client language and a yes', () => {
  it('tells Roman Urdu from English', () => {
    expect(isRomanUrdu('Danyal ka ledger bhej do')).toBe(true);
    expect(isRomanUrdu('Portal link bhi bhjdyen')).toBe(true);
    expect(isRomanUrdu('Give me khuzema ahmed ledger')).toBe(false);
    expect(isRomanUrdu('hello')).toBe(false);
  });

  it.each(['haan', 'haan ji', 'ji', 'yes', 'ok', 'theek hai', 'bilkul', 'yahi'])('%s is a yes', text => {
    expect(isYes(text)).toBe(true);
  });

  it.each(['nahi', 'no', 'danyal', '2', 'haan danyal ka ledger'])('%s is not a plain yes', text => {
    expect(isYes(text)).toBe(false);
  });

  it('the menu speaks Roman Urdu when asked to, and keeps the same numbers', () => {
    const roman = rootMenu(undefined, { roman: true });
    expect(roman).toContain('Aap ko kya chahiye?');
    expect(roman).toContain('1.  Kis ne paise dene hain');
    expect(rootMenu()).toContain('1.  Who owes me money');
  });
});
