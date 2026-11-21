import { describe, it, expect } from 'vitest';
import {
  AGENT_CONFIG_KEYS,
  AgentConfigEmployeeExtractionZ,
  AgentConfigZ,
  ExtractedAgentContentZ,
  POST_BOOKING_NOTICE_MAX_CHARS,
  PublishAgentConfigRequestZ,
  RebakeRequestZ,
} from './agentConfig.js';
import { validAgentConfig } from './agentConfigFixture.js';

describe('AgentConfigZ', () => {
  // The twin of this list is pinned in the UI repo
  // (amplify/functions/shared/aiConfig/agentConfig.test.ts). Change both together.
  it('has exactly the agreed keys, in order', () => {
    expect(AGENT_CONFIG_KEYS).toEqual([
      'employees',
      'services',
      'policies',
      'faq',
      'businessHours',
      'location',
      'businessHoursExceptions',
      'customGreeting',
      'serviceBookingStyle',
      'multilingual',
      'voiceId',
      'voiceModel',
      'voiceSpeed',
      'voiceTemperature',
      'ambientSound',
      'ambientSoundVolume',
      'businessWebsiteUrl',
      'bookingLink',
      'businessTimeZone',
      'consultationProtocol',
      'consultationInformation',
      'cancelOrRescheduleProtocol',
      'postBookingNotices',
      'questionRubric',
      'servicesExplicitlyNotOfferedInfo',
      'commonTermsAndNames',
      'additionalResponseConfiguration',
    ]);
  });

  it('accepts a complete config', () => {
    expect(AgentConfigZ.safeParse(validAgentConfig()).success).toBe(true);
  });

  it('requires every key (no top-level defaults)', () => {
    for (const key of AGENT_CONFIG_KEYS) {
      const config: Record<string, unknown> = { ...validAgentConfig() };
      delete config[key];
      expect({ key, success: AgentConfigZ.safeParse(config).success }).toEqual({ key, success: false });
    }
  });

  it('requires firstName, allows a missing lastName, and defaults servicesNotOffered', () => {
    const base = { id: 'e', role: '', specialties: [], bio: '', scheduleNotes: '' };
    const employees = (employee: Record<string, unknown>) => ({ ...validAgentConfig(), employees: [employee] });
    expect(AgentConfigZ.safeParse(employees({ ...base, firstName: '' })).success).toBe(false);
    const parsed = AgentConfigZ.parse(employees({ ...base, firstName: 'Ana' }));
    expect(parsed.employees[0]!.lastName).toBeUndefined();
    expect(parsed.employees[0]!.servicesNotOffered).toEqual([]);
    expect(AgentConfigZ.parse(employees({ ...base, firstName: 'Ana', lastName: 'Ruiz' })).employees[0]!.lastName).toBe('Ruiz');
  });

  it('caps each notice at the notice limit', () => {
    const notice = (text: string) =>
      validAgentConfig({
        postBookingNotices: { cancellationReminder: { voice: false, sms: false }, notices: [{ id: 'n', text, voice: true, sms: true }] },
      });
    expect(AgentConfigZ.safeParse(notice('x'.repeat(POST_BOOKING_NOTICE_MAX_CHARS))).success).toBe(true);
    expect(AgentConfigZ.safeParse(notice('x'.repeat(POST_BOOKING_NOTICE_MAX_CHARS + 1))).success).toBe(false);
    expect(AgentConfigZ.safeParse(notice('')).success).toBe(false);
  });

  it('does not cap additionalResponseConfiguration', () => {
    const notes = Array.from({ length: 50 }, () => 'n'.repeat(2000));
    expect(AgentConfigZ.safeParse(validAgentConfig({ additionalResponseConfiguration: notes })).success).toBe(true);
  });

  it('takes holiday dates as YYYY-MM-DD', () => {
    const holiday = (date: string) =>
      validAgentConfig({ businessHoursExceptions: [{ id: 'h', date, name: 'Closed', note: '', closedAllDay: true }] });
    expect(AgentConfigZ.safeParse(holiday('2026-12-25')).success).toBe(true);
    expect(AgentConfigZ.safeParse(holiday('12/25/2026')).success).toBe(false);
  });

  it('rejects the legacy string questionRubric and the removed consultation "not configured" null', () => {
    expect(AgentConfigZ.safeParse({ ...validAgentConfig(), questionRubric: 'Ask about hair length' }).success).toBe(false);
    expect(AgentConfigZ.safeParse({ ...validAgentConfig(), consultationProtocol: null }).success).toBe(false);
  });
});

describe('extraction picks', () => {
  it('cover exactly the extracted content keys', () => {
    expect(ExtractedAgentContentZ.keyof().options).toEqual(['employees', 'services', 'policies', 'faq', 'businessHours', 'location']);
  });

  it('extract employees without id or servicesNotOffered', () => {
    expect(AgentConfigEmployeeExtractionZ.keyof().options).toEqual(['firstName', 'lastName', 'role', 'specialties', 'bio', 'scheduleNotes', 'provenance']);
  });
});

describe('wire schemas', () => {
  it('publish needs a versionId and a full config', () => {
    expect(PublishAgentConfigRequestZ.safeParse({ versionId: 'v1', agentConfig: validAgentConfig() }).success).toBe(true);
    expect(PublishAgentConfigRequestZ.safeParse({ agentConfig: validAgentConfig() }).success).toBe(false);
  });

  it('rebake defaults to live', () => {
    expect(RebakeRequestZ.parse({})).toEqual({ target: 'live' });
    expect(RebakeRequestZ.parse(undefined)).toEqual({ target: 'live' });
    expect(RebakeRequestZ.safeParse(null).success).toBe(false);
    expect(RebakeRequestZ.parse({ target: 'test' })).toEqual({ target: 'test' });
    expect(RebakeRequestZ.safeParse({ target: 'staging' }).success).toBe(false);
  });
});
