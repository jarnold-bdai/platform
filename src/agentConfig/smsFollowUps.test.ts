import { describe, it, expect } from 'vitest';
import {
  cancellationReminderText,
  countSmsFollowUpMessages,
  SMS_MAX_MESSAGE_CHARS,
  smsFollowUpItems,
  splitFollowUps,
} from './smsFollowUps.js';
import type { AgentConfig, PostBookingNotice } from './agentConfig.js';
import { validAgentConfig } from './agentConfigFixture.js';

const LIMIT = SMS_MAX_MESSAGE_CHARS;
const ITEM_GAP = '\n\n';

/** A sentence of exactly `length` characters ending in a period. */
const sentence = (length: number, letter = 'a') => `${letter.repeat(length - 1)}.`;
/** Words of `wordLength` letters separated by single spaces, `count` of them. */
const words = (count: number, wordLength: number) => Array.from({ length: count }, () => 'w'.repeat(wordLength)).join(' ');

function expectWellFormed(messages: string[]) {
  for (const message of messages) {
    expect(message.length).toBeLessThanOrEqual(LIMIT);
    expect(message).toBe(message.trim());
    expect(message).not.toBe('');
  }
}

describe('splitFollowUps', () => {
  it('returns no messages for no items, or only blank ones', () => {
    expect(splitFollowUps([])).toEqual([]);
    expect(splitFollowUps(['', '  \n '])).toEqual([]);
  });

  it('trims items', () => {
    expect(splitFollowUps(['  hello \n'])).toEqual(['hello']);
  });

  it('keeps an item of exactly the limit whole', () => {
    const item = 'x'.repeat(LIMIT);
    expect(splitFollowUps([item])).toEqual([item]);
  });

  it('packs whole items with a blank line between them, up to the limit inclusive', () => {
    const half = (LIMIT - ITEM_GAP.length) / 2;
    const a = 'a'.repeat(half);
    const b = 'b'.repeat(half);
    expect(splitFollowUps([a, b])).toEqual([`${a}${ITEM_GAP}${b}`]);
  });

  it('starts a new message rather than splitting an item that fits on its own', () => {
    const a = 'a'.repeat(1000);
    const b = 'b. '.repeat(200).trim(); // 599 characters, splittable by sentence
    expect(splitFollowUps([a, b])).toEqual([a, b]);
  });

  it('splits an over-long item at paragraphs first', () => {
    const p1 = sentence(900, 'a');
    const p2 = sentence(900, 'b');
    expect(splitFollowUps([`${p1}\n\n${p2}`])).toEqual([p1, p2]);
  });

  it('re-packs small paragraphs of a split item, keeping their separators', () => {
    const p1 = sentence(1000, 'a');
    const p2 = sentence(300, 'b');
    const p3 = sentence(500, 'c');
    expect(splitFollowUps([`${p1}\n\n${p2}\n \n${p3}`])).toEqual([`${p1}\n\n${p2}`, p3]);
  });

  it('packs the first piece of a split item after the previous item when it fits', () => {
    const a = 'a'.repeat(100);
    const p1 = sentence(1000, 'b');
    const p2 = sentence(1000, 'c');
    expect(splitFollowUps([a, `${p1}\n\n${p2}`])).toEqual([`${a}${ITEM_GAP}${p1}`, p2]);
  });

  it('splits an over-long paragraph at sentences, keeping the punctuation with its sentence', () => {
    const s1 = sentence(1000, 'a');
    const s2 = `${'b'.repeat(799)}?`;
    const s3 = `${'c'.repeat(498)}!"`;
    const messages = splitFollowUps([`${s1} ${s2} ${s3}`]);
    expect(messages).toEqual([s1, `${s2} ${s3}`]);
  });

  it('splits an over-long sentence at words', () => {
    const text = words(400, 9); // 400 * 10 - 1 = 3999 characters, no sentence breaks
    const messages = splitFollowUps([text]);
    expectWellFormed(messages);
    expect(messages).toHaveLength(3);
    expect(messages.join(' ')).toBe(text);
    for (const message of messages) expect(message.split(' ').every((word) => word === 'w'.repeat(9))).toBe(true);
  });

  it('keeps newlines that separated words when splitting at words', () => {
    const line = 'w'.repeat(99);
    const text = Array.from({ length: 20 }, () => line).join('\n'); // 1999 characters, one paragraph, no sentences
    const messages = splitFollowUps([text]);
    expectWellFormed(messages);
    expect(messages.join('\n')).toBe(text);
  });

  it('hard-cuts only a single word longer than the limit', () => {
    const long = 'x'.repeat(LIMIT * 2 + 300);
    expect(splitFollowUps([`${long} tail`])).toEqual(['x'.repeat(LIMIT), 'x'.repeat(LIMIT), `${'x'.repeat(300)} tail`]);
  });

  it('never cuts inside a surrogate pair', () => {
    const emoji = '😀'; // two UTF-16 code units
    const long = emoji.repeat(LIMIT / 2 + 1);
    const messages = splitFollowUps([long]);
    expect(messages.map((message) => message.length)).toEqual([LIMIT, 2]);
    expect(messages.join('')).toBe(long);
  });

  it('keeps every message within the limit and loses no text (generated inputs)', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const separators = [' ', ' ', ' ', '. ', '! ', '\n', '\n\n', '?\n\n'];
    for (let round = 0; round < 200; round++) {
      const items = Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
        let item = '';
        const target = Math.floor(random() * 4000);
        while (item.length < target) {
          item += 'abcdefghij'.slice(0, 1 + Math.floor(random() * 10));
          if (random() < 0.002) item += 'z'.repeat(LIMIT + 10); // an occasional over-long word
          item += separators[Math.floor(random() * separators.length)];
        }
        return item;
      });
      const messages = splitFollowUps(items);
      expectWellFormed(messages);
      const squash = (text: string) => text.replace(/\s+/g, '');
      expect(squash(messages.join(''))).toBe(squash(items.join('')));
    }
  });
});

const notice = (id: string, text: string, flags: Partial<Pick<PostBookingNotice, 'voice' | 'sms'>> = {}): PostBookingNotice => ({
  id,
  text,
  voice: flags.voice ?? false,
  sms: flags.sms ?? true,
});

const cancellationPolicy = (description: string, title = 'Cancellations'): AgentConfig['policies'][number] => ({
  id: `p-${title}`,
  title,
  description,
  category: 'cancellation',
});

describe('cancellationReminderText', () => {
  it('is null without a non-blank cancellation policy', () => {
    expect(cancellationReminderText([])).toBeNull();
    expect(cancellationReminderText([cancellationPolicy('   ')])).toBeNull();
    expect(
      cancellationReminderText([{ id: 'p', title: 'Payment', description: 'Cash only', category: 'payment' }]),
    ).toBeNull();
  });

  it('covers every cancellation policy, as "Title: description", separated by blank lines', () => {
    expect(
      cancellationReminderText([cancellationPolicy('24 hours notice.', 'Cancellations'), cancellationPolicy(' No-shows pay 50%. ', 'No-shows')]),
    ).toBe('Cancellations: 24 hours notice.\n\nNo-shows: No-shows pay 50%.');
  });
});

describe('smsFollowUpItems', () => {
  it('puts the reminder first, then SMS-flagged notices in order, skipping voice-only ones', () => {
    const config = validAgentConfig({
      policies: [cancellationPolicy('24 hours notice.')],
      postBookingNotices: {
        cancellationReminder: { voice: false, sms: true },
        notices: [notice('a', 'First'), notice('b', 'Voice only', { sms: false, voice: true }), notice('c', 'Third')],
      },
    });
    expect(smsFollowUpItems(config)).toEqual(['Cancellations: 24 hours notice.', 'First', 'Third']);
  });

  it('skips the reminder when its SMS flag is off or there is no policy', () => {
    const notices = [notice('a', 'First')];
    expect(
      smsFollowUpItems(
        validAgentConfig({
          policies: [cancellationPolicy('24 hours notice.')],
          postBookingNotices: { cancellationReminder: { voice: true, sms: false }, notices },
        }),
      ),
    ).toEqual(['First']);
    expect(
      smsFollowUpItems(validAgentConfig({ postBookingNotices: { cancellationReminder: { voice: true, sms: true }, notices } })),
    ).toEqual(['First']);
  });
});

describe('countSmsFollowUpMessages (the 2-message rule input)', () => {
  const withSms = (policyLength: number, noticeLengths: number[]) =>
    validAgentConfig({
      policies: policyLength > 0 ? [cancellationPolicy('p'.repeat(policyLength), 'C')] : [],
      postBookingNotices: {
        cancellationReminder: { voice: false, sms: policyLength > 0 },
        notices: noticeLengths.map((length, index) => notice(`n${index}`, 'n'.repeat(length))),
      },
    });

  it('is 0 with nothing texted', () => {
    expect(countSmsFollowUpMessages(validAgentConfig())).toBe(0);
  });

  it('is 2 for a long policy plus notices that fit in a second message', () => {
    // "C: " + 1500 = 1503; then 500 + 2 + 500 + 2 + 500 = 1504.
    expect(countSmsFollowUpMessages(withSms(1500, [500, 500, 500]))).toBe(2);
  });

  it('is 3 when one more notice spills over', () => {
    expect(countSmsFollowUpMessages(withSms(1500, [500, 500, 500, 500]))).toBe(3);
  });

  it('counts a policy too long for two messages as 3', () => {
    expect(countSmsFollowUpMessages(withSms(LIMIT * 2, []))).toBe(3);
  });
});
