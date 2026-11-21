// ============================================================================
// SMS follow-ups after the booking-link text. The booking-link text stays a
// fixed template; the SMS-flagged items go out after it as follow-up messages,
// split to fit Twilio's per-message limit.
// Pure: used by the publishable rule (at most 2 follow-ups) and by the runtime
// sender, so the check and the send can never disagree.
//
// Ported from bdai-mvp-1 shared-types; this is now the single copy.
// ============================================================================

import type { AgentConfig } from './agentConfig.js';

/** Twilio rejects a longer body (error 21617). Measured in UTF-16 code units, which never undercounts. */
export const SMS_MAX_MESSAGE_CHARS = 1600;

/** At most this many follow-up messages per booking, enforced at publish and test. */
export const MAX_SMS_FOLLOW_UP_MESSAGES = 2;

/**
 * The cancellation-reminder text: every `category: 'cancellation'` policy with
 * a non-blank description, as "Title: description", separated by blank lines
 * (with several policies the reminder covers all of them). null when
 * there is none, in which case the reminder is skipped silently on both
 * channels and the page shows a warning.
 */
export function cancellationReminderText(policies: AgentConfig['policies']): string | null {
  const texts = policies
    .filter((policy) => policy.category === 'cancellation' && policy.description.trim() !== '')
    .map((policy) => `${policy.title.trim()}: ${policy.description.trim()}`);
  return texts.length > 0 ? texts.join('\n\n') : null;
}

/**
 * The SMS follow-up items, in their fixed order: the cancellation-reminder text
 * (when its SMS flag is on and there is a cancellation policy), then each
 * SMS-flagged notice in list order. Blank items are dropped.
 */
export function smsFollowUpItems(config: Pick<AgentConfig, 'policies' | 'postBookingNotices'>): string[] {
  const items: string[] = [];
  if (config.postBookingNotices.cancellationReminder.sms) {
    const reminder = cancellationReminderText(config.policies);
    if (reminder !== null) items.push(reminder);
  }
  for (const notice of config.postBookingNotices.notices) {
    if (notice.sms && notice.text.trim() !== '') items.push(notice.text.trim());
  }
  return items;
}

/** How many follow-up messages this config sends after each booking-link text. */
export function countSmsFollowUpMessages(config: Pick<AgentConfig, 'policies' | 'postBookingNotices'>): number {
  return splitFollowUps(smsFollowUpItems(config)).length;
}

/**
 * Packs follow-up items into as few messages of at most SMS_MAX_MESSAGE_CHARS
 * as a greedy fill allows. Whole items are packed in order, separated by a
 * blank line; an item is never split if it fits in one message (it starts a new
 * message instead). An item that is longer than one message is split at
 * paragraph boundaries, then a paragraph that is still too long at sentence
 * boundaries, then a sentence at word boundaries, and a single word longer than
 * a message is hard-cut (never inside a surrogate pair). The pieces of a split
 * item are packed greedily too, keeping the whitespace that separated them.
 * Each item is trimmed and blank items are dropped; no message is empty or has
 * leading or trailing whitespace.
 */
export function splitFollowUps(items: readonly string[]): string[] {
  const pieces: Piece[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (item === '') continue;
    const [first, ...rest] = splitToFit(item, 0);
    pieces.push({ separator: ITEM_SEPARATOR, text: first!.text }, ...rest);
  }

  const messages: string[] = [];
  let current = '';
  for (const { separator, text } of pieces) {
    if (current === '') {
      current = text;
    } else if (current.length + separator.length + text.length <= SMS_MAX_MESSAGE_CHARS) {
      current += separator + text;
    } else {
      messages.push(current);
      current = text;
    }
  }
  if (current !== '') messages.push(current);
  return messages;
}

/** A piece of an item, with the whitespace that preceded it in the item. */
interface Piece {
  separator: string;
  text: string;
}

const ITEM_SEPARATOR = '\n\n';

/** Split levels, coarsest first. Each returns the pieces with their separators. */
const SPLIT_LEVELS: ReadonlyArray<(text: string) => Piece[]> = [
  // Paragraphs: a whitespace run containing a blank line.
  (text) => splitOn(text, /\s*\n\s*\n\s*/g, () => ''),
  // Sentences: whitespace after . ! or ? (and any closing quote or bracket),
  // which stay with the sentence they end.
  (text) => splitOn(text, /([.!?]+["'”’)\]]*)(\s+)/g, (match) => match[1] ?? ''),
  // Words.
  (text) => splitOn(text, /\s+/g, () => ''),
];

/** `text` as pieces that each fit in one message. The first piece's separator is ''. */
function splitToFit(text: string, level: number): Piece[] {
  if (text.length <= SMS_MAX_MESSAGE_CHARS) return [{ separator: '', text }];
  if (level >= SPLIT_LEVELS.length) return hardCut(text);
  const parts = SPLIT_LEVELS[level]!(text);
  if (parts.length <= 1) return splitToFit(text, level + 1);
  return parts.flatMap((part) => {
    const [first, ...rest] = splitToFit(part.text, level + 1);
    return [{ separator: part.separator, text: first!.text }, ...rest];
  });
}

/**
 * Splits `text` at every match of `separator` (a global regex). `keep` returns
 * the leading part of a match that stays with the text before it (a sentence's
 * closing punctuation); the rest of the match becomes the next piece's separator.
 */
function splitOn(text: string, separator: RegExp, keep: (match: RegExpMatchArray) => string): Piece[] {
  const pieces: Piece[] = [];
  let pending = '';
  let start = 0;
  for (const match of text.matchAll(separator)) {
    const index = match.index ?? 0;
    const kept = keep(match);
    pieces.push({ separator: pending, text: text.slice(start, index + kept.length) });
    pending = match[0].slice(kept.length);
    start = index + match[0].length;
  }
  pieces.push({ separator: pending, text: text.slice(start) });
  return pieces.filter((piece) => piece.text !== '');
}

/** Cuts a single over-long word into message-sized chunks, by code point. */
function hardCut(text: string): Piece[] {
  const pieces: Piece[] = [];
  let chunk = '';
  for (const codePoint of text) {
    if (chunk.length + codePoint.length > SMS_MAX_MESSAGE_CHARS) {
      pieces.push({ separator: '', text: chunk });
      chunk = '';
    }
    chunk += codePoint;
  }
  if (chunk !== '') pieces.push({ separator: '', text: chunk });
  return pieces;
}
