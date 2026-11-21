import type { AgentConfig } from './agentConfig.js';

/** A minimal valid, publishable AgentConfig. Override any key. */
export function validAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    employees: [
      {
        id: 'e1',
        firstName: 'Ana',
        role: 'Stylist',
        specialties: [],
        servicesNotOffered: [],
        bio: '',
        scheduleNotes: '',
      },
    ],
    services: [{ id: 's1', name: 'Haircut', description: '', duration: '45m', price: '$50', category: 'Hair' }],
    policies: [],
    faq: [],
    businessHours: [],
    location: { address: '', city: '', state: '', zip: '', parkingInfo: '', accessibilityNotes: '' },
    businessHoursExceptions: [],
    customGreeting: null,
    serviceBookingStyle: 'alaCarte',
    multilingual: null,
    voiceId: '11labs-Adrian',
    voiceModel: 'eleven_multilingual_v2',
    voiceSpeed: 1,
    voiceTemperature: 1,
    ambientSound: null,
    ambientSoundVolume: 1,
    businessWebsiteUrl: null,
    bookingLink: 'https://example.com/book',
    businessTimeZone: 'America/New_York',
    consultationProtocol: 'escalateToOwner',
    consultationInformation: '',
    cancelOrRescheduleProtocol: null,
    postBookingNotices: { cancellationReminder: { voice: false, sms: false }, notices: [] },
    questionRubric: [],
    servicesExplicitlyNotOfferedInfo: [],
    commonTermsAndNames: '',
    additionalResponseConfiguration: [],
    ...overrides,
  };
}
