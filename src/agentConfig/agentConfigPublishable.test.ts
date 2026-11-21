import { describe, it, expect } from 'vitest';
import { AgentConfigPublishableZ, checkAgentConfigPublishable, isConsultationLikeService } from './agentConfigPublishable.js';
import type { AgentConfig, VoiceCatalog } from './agentConfig.js';
import { validAgentConfig } from './agentConfigFixture.js';

// The fixture's voice, 11labs-Adrian, is the multilingual one.
const CATALOG: VoiceCatalog = [
  { voiceId: '11labs-Adrian', multilingual: true, supportsDeliveryTone: true, voiceModel: 'eleven_multilingual_v2' },
  { voiceId: 'cartesia-Cleo', multilingual: false, supportsDeliveryTone: false },
];
const NO_LIMIT = { maxEmployees: null, voiceCatalog: CATALOG };
const limitOf = (maxEmployees: number) => ({ maxEmployees, voiceCatalog: CATALOG });
const employee = (id: string): AgentConfig['employees'][number] => ({
  id,
  firstName: `E${id}`,
  role: '',
  specialties: [],
  servicesNotOffered: [],
  bio: '',
  scheduleNotes: '',
});
const employees = (count: number) => Array.from({ length: count }, (_, index) => employee(String(index)));
const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

describe('checkAgentConfigPublishable', () => {
  it('reports nothing for a valid config', () => {
    expect(checkAgentConfigPublishable(validAgentConfig(), NO_LIMIT)).toEqual({ blocking: [], warnings: [] });
    expect(AgentConfigPublishableZ(NO_LIMIT).safeParse(validAgentConfig()).success).toBe(true);
  });

  describe('NO_EMPLOYEES (blocking)', () => {
    it('blocks zero employees, with or without a limit', () => {
      for (const input of [NO_LIMIT, limitOf(10)]) {
        const result = checkAgentConfigPublishable(validAgentConfig({ employees: [] }), input);
        expect(codes(result.blocking)).toEqual(['NO_EMPLOYEES']);
        expect(result.blocking[0]!.path).toEqual(['employees']);
        expect(result.warnings).toEqual([]);
      }
    });
  });

  describe('TOO_MANY_EMPLOYEES (blocking)', () => {
    it('allows exactly the limit and blocks one over', () => {
      expect(checkAgentConfigPublishable(validAgentConfig({ employees: employees(10) }), limitOf(10)).blocking).toEqual([]);
      expect(codes(checkAgentConfigPublishable(validAgentConfig({ employees: employees(11) }), limitOf(10)).blocking)).toEqual([
        'TOO_MANY_EMPLOYEES',
      ]);
    });

    it('treats indie (limit 1) as exactly one employee', () => {
      expect(checkAgentConfigPublishable(validAgentConfig({ employees: employees(1) }), limitOf(1)).blocking).toEqual([]);
      expect(codes(checkAgentConfigPublishable(validAgentConfig({ employees: employees(2) }), limitOf(1)).blocking)).toEqual([
        'TOO_MANY_EMPLOYEES',
      ]);
    });

    it('has no limit when maxEmployees is null', () => {
      expect(checkAgentConfigPublishable(validAgentConfig({ employees: employees(500) }), NO_LIMIT).blocking).toEqual([]);
    });
  });

  describe('NO_BOOKING_LINK (blocking)', () => {
    it('blocks an empty or blank booking link', () => {
      for (const bookingLink of ['', '   ']) {
        const result = checkAgentConfigPublishable(validAgentConfig({ bookingLink }), NO_LIMIT);
        expect(codes(result.blocking)).toEqual(['NO_BOOKING_LINK']);
        expect(result.blocking[0]!.path).toEqual(['bookingLink']);
      }
    });
  });

  describe('TOO_MANY_SMS_FOLLOW_UPS (blocking)', () => {
    const notices = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `n${index}`, text: 'n'.repeat(500), voice: false, sms: true }));

    it('allows 2 follow-up messages and blocks 3', () => {
      // 500 + 2 + 500 + 2 + 500 = 1504 per message: 6 notices fit in 2 messages, 7 need 3.
      const two = validAgentConfig({ postBookingNotices: { cancellationReminder: { voice: false, sms: false }, notices: notices(6) } });
      const three = validAgentConfig({ postBookingNotices: { cancellationReminder: { voice: false, sms: false }, notices: notices(7) } });
      expect(checkAgentConfigPublishable(two, NO_LIMIT).blocking).toEqual([]);
      const result = checkAgentConfigPublishable(three, NO_LIMIT);
      expect(codes(result.blocking)).toEqual(['TOO_MANY_SMS_FOLLOW_UPS']);
      expect(result.blocking[0]!.message).toContain('3 messages');
    });

    it('ignores voice-only notices', () => {
      const voiceOnly = notices(20).map((notice) => ({ ...notice, sms: false, voice: true }));
      const config = validAgentConfig({ postBookingNotices: { cancellationReminder: { voice: false, sms: false }, notices: voiceOnly } });
      expect(checkAgentConfigPublishable(config, NO_LIMIT).blocking).toEqual([]);
    });

    it('counts a texted cancellation policy', () => {
      const config = validAgentConfig({
        policies: [{ id: 'p', title: 'Cancellations', description: 'p'.repeat(3300), category: 'cancellation' }],
        postBookingNotices: { cancellationReminder: { voice: false, sms: true }, notices: [] },
      });
      expect(codes(checkAgentConfigPublishable(config, NO_LIMIT).blocking)).toEqual(['TOO_MANY_SMS_FOLLOW_UPS']);
    });
  });

  describe('VOICE_NOT_AVAILABLE (blocking)', () => {
    it('blocks a config with no voice chosen yet', () => {
      const result = checkAgentConfigPublishable(validAgentConfig({ voiceId: '', voiceModel: null }), NO_LIMIT);
      expect(codes(result.blocking)).toEqual(['VOICE_NOT_AVAILABLE']);
      expect(result.blocking[0]).toEqual({
        code: 'VOICE_NOT_AVAILABLE',
        message: 'Choose a voice before you test or publish.',
        path: ['voiceId'],
      });
    });

    it('blocks a voice the catalog no longer offers, with its own message', () => {
      const result = checkAgentConfigPublishable(validAgentConfig({ voiceId: '11labs-Retired' }), NO_LIMIT);
      expect(codes(result.blocking)).toEqual(['VOICE_NOT_AVAILABLE']);
      expect(result.blocking[0]!.message).toBe(
        'The voice you chose is no longer offered. Choose another voice before you test or publish.',
      );
      expect(result.blocking[0]!.path).toEqual(['voiceId']);
    });

    it('reports only VOICE_NOT_AVAILABLE for an unknown voice with multilingual on', () => {
      const config = validAgentConfig({ voiceId: '11labs-Retired', multilingual: 'v2' });
      expect(codes(checkAgentConfigPublishable(config, NO_LIMIT).blocking)).toEqual(['VOICE_NOT_AVAILABLE']);
    });

    it('allows any catalog voice', () => {
      for (const voiceId of ['11labs-Adrian', 'cartesia-Cleo']) {
        expect(checkAgentConfigPublishable(validAgentConfig({ voiceId }), NO_LIMIT)).toEqual({ blocking: [], warnings: [] });
      }
    });
  });

  describe('VOICE_NOT_MULTILINGUAL (blocking)', () => {
    it('blocks an English-only voice while multilingual is on', () => {
      const config = validAgentConfig({ voiceId: 'cartesia-Cleo', voiceModel: null, multilingual: 'v2' });
      const result = checkAgentConfigPublishable(config, NO_LIMIT);
      expect(result.blocking).toEqual([
        {
          code: 'VOICE_NOT_MULTILINGUAL',
          message: "Your voice only speaks English, so multilingual calls can't be on. Choose a multilingual voice or turn multilingual off.",
          path: ['voiceId'],
        },
      ]);
      expect(AgentConfigPublishableZ(NO_LIMIT).safeParse(config).success).toBe(false);
    });

    it('allows a multilingual voice with multilingual on, and any voice with it off', () => {
      expect(checkAgentConfigPublishable(validAgentConfig({ multilingual: 'v2' }), NO_LIMIT).blocking).toEqual([]);
      expect(checkAgentConfigPublishable(validAgentConfig({ voiceId: 'cartesia-Cleo', multilingual: null }), NO_LIMIT).blocking).toEqual([]);
    });
  });

  it('skips both voice rules when the catalog is null', () => {
    const noCatalog = { maxEmployees: null, voiceCatalog: null };
    for (const overrides of [
      { voiceId: '' },
      { voiceId: '11labs-Retired' },
      { voiceId: 'cartesia-Cleo', multilingual: 'v2' as const },
    ]) {
      const config = validAgentConfig(overrides);
      expect(checkAgentConfigPublishable(config, noCatalog)).toEqual({ blocking: [], warnings: [] });
      expect(AgentConfigPublishableZ(noCatalog).safeParse(config).success).toBe(true);
    }
  });

  describe('CANCELLATION_REMINDER_WITHOUT_POLICY (warning)', () => {
    it.each([
      [{ voice: true, sms: false }],
      [{ voice: false, sms: true }],
    ])('warns when a reminder flag is on with no cancellation policy (%j), without blocking', (cancellationReminder) => {
      const config = validAgentConfig({ postBookingNotices: { cancellationReminder, notices: [] } });
      const result = checkAgentConfigPublishable(config, NO_LIMIT);
      expect(result.blocking).toEqual([]);
      expect(codes(result.warnings)).toEqual(['CANCELLATION_REMINDER_WITHOUT_POLICY']);
      expect(AgentConfigPublishableZ(NO_LIMIT).safeParse(config).success).toBe(true);
    });

    it('counts a cancellation policy with only a blank description as none', () => {
      const config = validAgentConfig({
        policies: [{ id: 'p', title: 'Cancellations', description: ' ', category: 'cancellation' }],
        postBookingNotices: { cancellationReminder: { voice: true, sms: false }, notices: [] },
      });
      expect(codes(checkAgentConfigPublishable(config, NO_LIMIT).warnings)).toEqual(['CANCELLATION_REMINDER_WITHOUT_POLICY']);
    });

    it('does not warn with a cancellation policy, or with both flags off', () => {
      const withPolicy = validAgentConfig({
        policies: [{ id: 'p', title: 'Cancellations', description: '24 hours notice', category: 'cancellation' }],
        postBookingNotices: { cancellationReminder: { voice: true, sms: true }, notices: [] },
      });
      expect(checkAgentConfigPublishable(withPolicy, NO_LIMIT)).toEqual({ blocking: [], warnings: [] });
      expect(checkAgentConfigPublishable(validAgentConfig(), NO_LIMIT).warnings).toEqual([]);
    });
  });

  describe('CONSULTATION_BOOKING_WITHOUT_CONSULTATION_SERVICE (warning)', () => {
    it('warns when consultation booking is chosen with no consultation-like service, without blocking', () => {
      const config = validAgentConfig({ consultationProtocol: 'findConsultationAvailability' });
      const result = checkAgentConfigPublishable(config, NO_LIMIT);
      expect(result.blocking).toEqual([]);
      expect(codes(result.warnings)).toEqual(['CONSULTATION_BOOKING_WITHOUT_CONSULTATION_SERVICE']);
      expect(result.warnings[0]!.path).toEqual(['consultationProtocol']);
    });

    it('does not warn with a consultation service, or for the other protocols', () => {
      const consultation = { id: 's2', name: 'Color Consultation', description: '', duration: '', price: '', category: '' };
      expect(
        checkAgentConfigPublishable(
          validAgentConfig({ consultationProtocol: 'findConsultationAvailability', services: [consultation] }),
          NO_LIMIT,
        ).warnings,
      ).toEqual([]);
      for (const consultationProtocol of ['escalateToOwner', 'guessBestService'] as const) {
        expect(checkAgentConfigPublishable(validAgentConfig({ consultationProtocol }), NO_LIMIT).warnings).toEqual([]);
      }
    });

    it('matches "consult" in the name or the category, any case', () => {
      const service = { id: 's', name: 'Cut', description: '', duration: '', price: '', category: '' };
      expect(isConsultationLikeService(service)).toBe(false);
      expect(isConsultationLikeService({ ...service, name: 'CONSULT - extensions' })).toBe(true);
      expect(isConsultationLikeService({ ...service, category: 'Consultations' })).toBe(true);
    });
  });

  describe('ALL_BUSINESS_HOURS_CLOSED (warning)', () => {
    const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
    const week = (closed: (day: string) => boolean): AgentConfig['businessHours'] =>
      DAYS.map((day) => ({ day, open: '09:00', close: '17:00', closed: closed(day) }));

    it('warns when every day is closed, without blocking', () => {
      const config = validAgentConfig({ businessHours: week(() => true) });
      const result = checkAgentConfigPublishable(config, NO_LIMIT);
      expect(result.blocking).toEqual([]);
      expect(codes(result.warnings)).toEqual(['ALL_BUSINESS_HOURS_CLOSED']);
      expect(result.warnings[0]!.path).toEqual(['businessHours']);
    });

    it('does not warn with no hours, or with any day open', () => {
      expect(checkAgentConfigPublishable(validAgentConfig({ businessHours: [] }), NO_LIMIT).warnings).toEqual([]);
      const sundayOpen = validAgentConfig({ businessHours: week((day) => day !== 'sunday') });
      expect(checkAgentConfigPublishable(sundayOpen, NO_LIMIT).warnings).toEqual([]);
    });

    it('does not warn for closed days that are not the whole week', () => {
      const partial = week(() => true).filter((entry) => entry.day !== 'sunday');
      expect(checkAgentConfigPublishable(validAgentConfig({ businessHours: partial }), NO_LIMIT).warnings).toEqual([]);
      // Seven entries with a day repeated still leave a day unmentioned.
      const repeated = [...partial, { ...partial[0]! }];
      expect(checkAgentConfigPublishable(validAgentConfig({ businessHours: repeated }), NO_LIMIT).warnings).toEqual([]);
    });
  });

  it('reports blocking and warning issues together', () => {
    const config = validAgentConfig({
      employees: [],
      consultationProtocol: 'findConsultationAvailability',
      postBookingNotices: { cancellationReminder: { voice: true, sms: true }, notices: [] },
    });
    const result = checkAgentConfigPublishable(config, NO_LIMIT);
    expect(codes(result.blocking)).toEqual(['NO_EMPLOYEES']);
    expect(codes(result.warnings)).toEqual([
      'CANCELLATION_REMINDER_WITHOUT_POLICY',
      'CONSULTATION_BOOKING_WITHOUT_CONSULTATION_SERVICE',
    ]);
  });

  it('reports schema errors as blocking INVALID_CONFIG, with no warnings', () => {
    const result = checkAgentConfigPublishable({ ...validAgentConfig(), bookingLink: 42 }, NO_LIMIT);
    expect(codes(result.blocking)).toEqual(['INVALID_CONFIG']);
    expect(result.blocking[0]!.path).toEqual(['bookingLink']);
    expect(result.warnings).toEqual([]);
  });

  it('tags rule issues with their code and severity in the Zod params', () => {
    const parsed = AgentConfigPublishableZ(NO_LIMIT).safeParse(validAgentConfig({ employees: [] }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      expect(issue!.code).toBe('custom');
      expect(issue!.code === 'custom' && (issue as { params?: unknown }).params).toEqual({ publishIssueCode: 'NO_EMPLOYEES', severity: 'blocking' });
    }
  });
});
