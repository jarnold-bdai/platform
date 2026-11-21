// ============================================================================
// AgentConfigPublishableZ: the cross-field rules a whole agent config must
// pass before it can be tested or published. A draft may break them (a
// field-at-a-time save can't check them); test and publish refuse on the
// blocking ones server-side, and the structured config page lists every issue,
// blocking or not, in its warning banner. Both sides run this one module, so
// they can't disagree.
//
// API
// - `AgentConfigPublishableZ(input)`: `AgentConfigZ.superRefine(…)` carrying the
//   BLOCKING rules only, so `safeParse(x).success` means exactly "may be
//   tested and published". Each rule issue is a Zod `custom` issue whose
//   `params` are `{ publishIssueCode, severity: 'blocking' }`.
// - `checkAgentConfigPublishable(config, input)`: returns `{ blocking, warnings }`
//   as `PublishIssue[]`. `blocking` holds the schema errors (code
//   `INVALID_CONFIG`, one per Zod issue) and the blocking rules; `warnings`
//   holds the warning rules. Server: refuse when `blocking.length > 0`.
//   Page: show both lists. Warning rules run only on a config that passes
//   `AgentConfigZ`, since they need a typed config.
// - Input `{ maxEmployees: number | null, voiceCatalog }`: the plan's employee
//   limit, null meaning no limit (a business with no subscription), and the
//   deploy-time voice catalog.
//
// Ported from bdai-mvp-1 shared-types; this is now the single copy.
// The two files are identical apart from this line.
// ============================================================================

import { z } from 'zod';
import { AgentConfigZ, findCatalogVoice, type AgentConfig, type VoiceCatalog } from './agentConfig.js';
import { cancellationReminderText, countSmsFollowUpMessages, MAX_SMS_FOLLOW_UP_MESSAGES } from './smsFollowUps.js';

export interface PublishabilityInput {
  /** The plan's employee limit; null means no limit. */
  maxEmployees: number | null;
  /**
   * The deploy-time voice catalog (RETELL_VOICE_CATALOG): the voices a config
   * may use. null skips the voice rules: the page before the catalog loads,
   * and bdai-mvp-1's own payload check, which has no catalog. The UI backend's
   * test and publish gates always pass it.
   */
  voiceCatalog: VoiceCatalog | null;
}

export const PublishIssueCodeZ = z.enum([
  /** The config fails `AgentConfigZ` itself. */
  'INVALID_CONFIG',
  /** Blocking. */
  'NO_EMPLOYEES',
  /** Blocking. */
  'TOO_MANY_EMPLOYEES',
  /** Blocking (decided 2026-10-26): no booking link, so the booking text would have nothing to send. */
  'NO_BOOKING_LINK',
  /** Blocking: SMS-flagged items need more than MAX_SMS_FOLLOW_UP_MESSAGES messages. */
  'TOO_MANY_SMS_FOLLOW_UPS',
  /** Blocking: multilingual is on and the voice isn't multilingual in the catalog. */
  'VOICE_NOT_MULTILINGUAL',
  /** Blocking: the voice isn't in the catalog (none chosen yet, or removed from the deploy config). */
  'VOICE_NOT_AVAILABLE',
  /** Warning: a reminder flag is on and there is no cancellation policy text. */
  'CANCELLATION_REMINDER_WITHOUT_POLICY',
  /** Warning: "Book a consultation appointment" with no consultation-like service. */
  'CONSULTATION_BOOKING_WITHOUT_CONSULTATION_SERVICE',
  /** Warning: hours cover all seven days and every one is closed, so callers hear the business is closed all week. */
  'ALL_BUSINESS_HOURS_CLOSED',
]);
export type PublishIssueCode = z.infer<typeof PublishIssueCodeZ>;

export const PublishIssueSeverityZ = z.enum(['blocking', 'warning']);
export type PublishIssueSeverity = z.infer<typeof PublishIssueSeverityZ>;

/** One problem, as returned to the page and in a refusal. `message` is user-facing. */
export const PublishIssueZ = z.object({
  code: PublishIssueCodeZ,
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
});
export type PublishIssue = z.infer<typeof PublishIssueZ>;

export interface PublishCheckResult {
  blocking: PublishIssue[];
  warnings: PublishIssue[];
}

/** A service "looks like a consultation" when its name or category mentions one. */
export function isConsultationLikeService(service: AgentConfig['services'][number]): boolean {
  return /consult/i.test(service.name) || /consult/i.test(service.category);
}

interface PublishRule {
  code: Exclude<PublishIssueCode, 'INVALID_CONFIG'>;
  severity: PublishIssueSeverity;
  /** The issue's message and path, or null when the config passes. */
  check: (config: AgentConfig, input: PublishabilityInput) => Omit<PublishIssue, 'code'> | null;
}

/** Every rule, with its severity. Order is the order issues are reported in. */
const PUBLISH_RULES: readonly PublishRule[] = [
  {
    code: 'NO_EMPLOYEES',
    severity: 'blocking',
    check: (config) =>
      config.employees.length === 0
        ? { message: 'Add at least one employee before you test or publish.', path: ['employees'] }
        : null,
  },
  {
    code: 'TOO_MANY_EMPLOYEES',
    severity: 'blocking',
    check: (config, { maxEmployees }) =>
      maxEmployees !== null && config.employees.length > maxEmployees
        ? {
            message: `Your plan allows ${maxEmployees} ${maxEmployees === 1 ? 'employee' : 'employees'}, and this configuration has ${config.employees.length}. Remove employees or upgrade your plan to test or publish.`,
            path: ['employees'],
          }
        : null,
  },
  {
    code: 'NO_BOOKING_LINK',
    severity: 'blocking',
    check: (config) =>
      config.bookingLink.trim() === ''
        ? { message: 'Add your booking link before you test or publish.', path: ['bookingLink'] }
        : null,
  },
  {
    code: 'TOO_MANY_SMS_FOLLOW_UPS',
    severity: 'blocking',
    check: (config) => {
      const count = countSmsFollowUpMessages(config);
      return count > MAX_SMS_FOLLOW_UP_MESSAGES
        ? {
            message: `The texts sent after each booking link would take ${count} messages; the limit is ${MAX_SMS_FOLLOW_UP_MESSAGES}. Shorten the notices and cancellation policy that are texted, or stop texting some of them.`,
            path: ['postBookingNotices'],
          }
        : null;
    },
  },
  {
    // `voiceId` is a plain string so a voice removed from the deploy config
    // doesn't break stored versions; this rule is where the catalog applies.
    // Skipped (like VOICE_NOT_MULTILINGUAL) until the catalog is known.
    code: 'VOICE_NOT_AVAILABLE',
    severity: 'blocking',
    check: (config, { voiceCatalog }) => {
      if (voiceCatalog === null || findCatalogVoice(voiceCatalog, config.voiceId)) return null;
      return {
        message:
          config.voiceId === ''
            ? 'Choose a voice before you test or publish.'
            : 'The voice you chose is no longer offered. Choose another voice before you test or publish.',
        path: ['voiceId'],
      };
    },
  },
  {
    // Path `voiceId`, not `multilingual`: either fix works, but the voice
    // picker is where the user sees which voices are multilingual. A voice
    // missing from the catalog is VOICE_NOT_AVAILABLE's, not this rule's.
    code: 'VOICE_NOT_MULTILINGUAL',
    severity: 'blocking',
    check: (config, { voiceCatalog }) => {
      if (voiceCatalog === null || !config.multilingual) return null;
      const voice = findCatalogVoice(voiceCatalog, config.voiceId);
      return voice && !voice.multilingual
        ? {
            message:
              "Your voice only speaks English, so multilingual calls can't be on. Choose a multilingual voice or turn multilingual off.",
            path: ['voiceId'],
          }
        : null;
    },
  },
  {
    code: 'CANCELLATION_REMINDER_WITHOUT_POLICY',
    severity: 'warning',
    check: (config) => {
      const { voice, sms } = config.postBookingNotices.cancellationReminder;
      return (voice || sms) && cancellationReminderText(config.policies) === null
        ? {
            message: 'The cancellation-policy reminder is on, but you have no cancellation policy, so nothing will be said or sent.',
            path: ['postBookingNotices', 'cancellationReminder'],
          }
        : null;
    },
  },
  {
    code: 'CONSULTATION_BOOKING_WITHOUT_CONSULTATION_SERVICE',
    severity: 'warning',
    check: (config) =>
      config.consultationProtocol === 'findConsultationAvailability' && !config.services.some(isConsultationLikeService)
        ? {
            message: '"Book a consultation appointment" is selected, but none of your services looks like a consultation. Add your consultation service, or choose another option.',
            path: ['consultationProtocol'],
          }
        : null,
  },
  {
    // Empty hours render nothing in the prompt, but each closed day renders as
    // "<Day>: Closed". Switching Regular hours on seeds every day closed. Only a
    // full week warns: a partial list leaves the other days unmentioned. `day`
    // is a seven-value enum, so seven distinct days is the whole week.
    code: 'ALL_BUSINESS_HOURS_CLOSED',
    severity: 'warning',
    check: (config) =>
      new Set(config.businessHours.map((entry) => entry.day)).size === 7 &&
      config.businessHours.every((entry) => entry.closed)
        ? {
            message: "Regular hours are on, but every day is closed, so callers will be told you're closed all week. Open the days you work, or switch Regular hours off if you're appointment-only.",
            path: ['businessHours'],
          }
        : null,
  },
];

const RuleIssueParamsZ = z.object({
  publishIssueCode: PublishIssueCodeZ,
  severity: PublishIssueSeverityZ,
});

/** `AgentConfigZ` plus the blocking rules. Success means the config may be tested and published. */
export const AgentConfigPublishableZ = (input: PublishabilityInput) =>
  AgentConfigZ.superRefine((config, ctx) => {
    for (const rule of PUBLISH_RULES) {
      if (rule.severity !== 'blocking') continue;
      const issue = rule.check(config, input);
      if (issue === null) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
        params: { publishIssueCode: rule.code, severity: rule.severity },
      });
    }
  });

/** Every problem with `config`, split into blocking and warning. See the header. */
export function checkAgentConfigPublishable(config: unknown, input: PublishabilityInput): PublishCheckResult {
  const blocking: PublishIssue[] = [];
  const parsed = AgentConfigPublishableZ(input).safeParse(config);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const params = issue.code === z.ZodIssueCode.custom ? RuleIssueParamsZ.safeParse(issue.params) : null;
      blocking.push({
        code: params?.success ? params.data.publishIssueCode : 'INVALID_CONFIG',
        message: issue.message,
        path: issue.path,
      });
    }
  }

  const base = AgentConfigZ.safeParse(config);
  const warnings: PublishIssue[] = [];
  if (base.success) {
    for (const rule of PUBLISH_RULES) {
      if (rule.severity !== 'warning') continue;
      const issue = rule.check(base.data, input);
      if (issue !== null) warnings.push({ code: rule.code, ...issue });
    }
  }
  return { blocking, warnings };
}
