// ============================================================================
// AgentConfigZ: the one agent-config schema. Every user-set agent field, flat,
// one column per key in both stores: the Comms `AgentConfiguration` table (one row per business and slot)
// and the Amplify `AiConfiguration` structured DRAFT / VERSION# records. It is
// also the publish and test payload.
//
// Ported from bdai-mvp-1 shared-types; this is now the single copy.
// Everything below the "SHARED BODY" marker is identical in both files; only the
// imports above it differ. There is no automated cross-repo check: each repo
// has a test pinning the exact key list, so a one-sided change fails that repo's
// test until the twin is updated too.
//
// Row metadata (Comms: businessId, slot, publishedVersionId, updatedAt; Amplify:
// pk/sk, versionId, configType, …) is NOT part of this schema. Keys must not
// collide with those metadata names, and Comms writes must use
// `#name` placeholders (`location` is a DynamoDB reserved word).
// ============================================================================

import { z } from 'zod';
import {
  ServiceBookingStyleZod as ServiceBookingStyleZ,
  ConsultationProtocolZod as ConsultationProtocolZ,
  MultilingualVersionZod as MultilingualVersionZ,
} from './fieldDefinitions.js';
import { CancelOrRescheduleProtocolZod as CancelOrRescheduleProtocolZ } from './cancelOrRescheduleProtocol.js';
import {
  ProvenanceZ,
  ServiceZ,
  PolicyZ,
  FaqEntryZ,
  BusinessHoursEntryZ,
  BusinessLocationZ,
  DiscoveredUrlZ,
} from './structuredTypes.js';

// ======================== SHARED BODY (identical in both repos) ========================

// ---------------------------------------------------------------------------
// Content sub-schemas that are new or changed for the agent config. The
// unchanged ones (services, policies, FAQ, hours, location) are imported.
// ---------------------------------------------------------------------------

/**
 * An employee. Replaces the old `EmployeeZ` (`name`) for the agent
 * config: `firstName` is required, `lastName` optional (imports and websites
 * often list first names only). `servicesNotOffered` replaces legacy
 * `employeeExclusionsInfo` as a field on the employee, so it can't go stale on
 * a rename.
 */
export const AgentConfigEmployeeZ = z.object({
  id: z.string(),
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().optional(),
  role: z.string().default(''),
  specialties: z.array(z.string()).default([]),
  servicesNotOffered: z.array(z.string()).default([]),
  bio: z.string().default(''),
  scheduleNotes: z.string().default(''),
  provenance: ProvenanceZ.optional(),
});
export type AgentConfigEmployee = z.infer<typeof AgentConfigEmployeeZ>;

/**
 * A holiday or closure. Replaces legacy `listOfHolidaysInIso8601`
 * (`{ date, holidayName, holidayNote, closedAllDay }`).
 */
export const BusinessHoursExceptionZ = z.object({
  id: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  name: z.string().min(1, 'Name is required'),
  note: z.string().default(''),
  closedAllDay: z.boolean(),
});
export type BusinessHoursException = z.infer<typeof BusinessHoursExceptionZ>;

/** About 500 characters per post-booking notice, enforced here. */
export const POST_BOOKING_NOTICE_MAX_CHARS = 500;

/**
 * One post-booking notice. `voice`: the voice agent says it after
 * sending the booking link. `sms`: it is texted as a follow-up message after
 * the booking-link text (see `smsFollowUps.ts`).
 */
export const PostBookingNoticeZ = z.object({
  id: z.string(),
  text: z
    .string()
    .min(1, 'Notice text is required')
    .max(POST_BOOKING_NOTICE_MAX_CHARS, `Keep each notice to ${POST_BOOKING_NOTICE_MAX_CHARS} characters or fewer`),
  voice: z.boolean(),
  sms: z.boolean(),
});
export type PostBookingNotice = z.infer<typeof PostBookingNoticeZ>;

/**
 * Post-booking notices. All enabled items apply, in a fixed order: the
 * cancellation reminder first, then `notices` in list order. The reminder has
 * no text of its own: it reuses the `category: 'cancellation'` policies.
 */
export const PostBookingNoticesZ = z.object({
  cancellationReminder: z.object({ voice: z.boolean(), sms: z.boolean() }),
  notices: z.array(PostBookingNoticeZ),
});
export type PostBookingNotices = z.infer<typeof PostBookingNoticesZ>;

/** One question-rubric entry. The legacy `string` variant is gone. */
export const QuestionRubricEntryZ = z.object({
  id: z.string(),
  trigger: z.string().min(1, 'Trigger is required'),
  instructions: z.string().min(1, 'Instructions are required'),
});
export type QuestionRubricEntry = z.infer<typeof QuestionRubricEntryZ>;

/** What a new config starts with, and what migration writes for an unset value. */
export const DEFAULT_CONSULTATION_PROTOCOL: z.infer<typeof ConsultationProtocolZ> = 'escalateToOwner';

/**
 * Retell's TTS models (`voice_model` on the agent, retell-sdk 6.2.10). Never
 * user-facing: copied from the voice catalog entry when a voice is picked.
 */
export const VoiceModelZ = z.enum([
  'eleven_flash_v2',
  'eleven_flash_v2_5',
  'eleven_multilingual_v2',
  'eleven_v3',
  'eleven_v3_conversational',
  'eleven_v4',
  'eleven_v4_turbo',
  'sonic-3',
  'sonic-3-latest',
  'sonic-3.5',
  'sonic-3.6',
  'tts-1',
  'gpt-4o-mini-tts',
  'speech-02-turbo',
  'speech-2.8-turbo',
  's1',
  's2-pro',
  's2.1-pro',
  'inworld-tts-2',
  'inworld-tts-2-flash',
]);
export type VoiceModel = z.infer<typeof VoiceModelZ>;

/** Retell's background sounds (`ambient_sound` on the agent, retell-sdk 6.2.10). */
export const AmbientSoundZ = z.enum([
  'coffee-shop',
  'convention-hall',
  'summer-outdoor',
  'mountain-outdoor',
  'static-noise',
  'call-center',
]);
export type AmbientSound = z.infer<typeof AmbientSoundZ>;

/** Retell's defaults for the voice and sound settings, used when nothing is set. */
export const DEFAULT_VOICE_SPEED = 1;
export const DEFAULT_VOICE_TEMPERATURE = 1;
export const DEFAULT_AMBIENT_SOUND_VOLUME = 1;

// ---------------------------------------------------------------------------
// The schema. Composed from three field groups for readability and for the
// extraction `.pick()`s below; the stored data is flat.
// ---------------------------------------------------------------------------

/** Content: what extraction, the editor tabs and the renderer deal in. */
const agentConfigContentShape = {
  employees: z.array(AgentConfigEmployeeZ),
  services: z.array(ServiceZ),
  policies: z.array(PolicyZ),
  faq: z.array(FaqEntryZ),
  businessHours: z.array(BusinessHoursEntryZ),
  location: BusinessLocationZ,
  businessHoursExceptions: z.array(BusinessHoursExceptionZ),
};

/** The former Agent Settings, plus the consultation pair. */
const agentConfigSettingsShape = {
  /** null: the greeting is generated from the business name. */
  customGreeting: z.string().nullable(),
  serviceBookingStyle: ServiceBookingStyleZ,
  /** null: multilingual off. */
  multilingual: MultilingualVersionZ.nullable(),
  /**
   * A Retell voice id. Not an enum: the offered voices are deploy config (the
   * voice catalog), and a voice removed from it must not make stored versions
   * fail to parse. The catalog check is a publish rule (`VOICE_NOT_AVAILABLE`).
   */
  voiceId: z.string(),
  /** Copied from the voice's catalog entry when it is picked; not user-editable. null: Retell chooses. */
  voiceModel: VoiceModelZ.nullable(),
  /** "Speaking speed". */
  voiceSpeed: z.number().min(0.5).max(2),
  /** "Delivery tone": 0 predictable, 2 expressive. Only some providers use it. */
  voiceTemperature: z.number().min(0).max(2),
  /** Background sound under the call. null: none. */
  ambientSound: AmbientSoundZ.nullable(),
  ambientSoundVolume: z.number().min(0).max(2),
  /** null: no website; the spoken form is derived at render time. */
  businessWebsiteUrl: z.string().nullable(),
  bookingLink: z.string(),
  businessTimeZone: z.string(),
  /** Required: "Not configured" is gone. New configs use DEFAULT_CONSULTATION_PROTOCOL. */
  consultationProtocol: ConsultationProtocolZ,
  /** When a consultation is needed (free text, '' allowed). The protocol says what to do. */
  consultationInformation: z.string(),
};

/** The receptionist-behavior fields beyond the content and the former Agent Settings. */
const agentConfigAdditionsShape = {
  /** null: off; cancel and reschedule requests are escalated. */
  cancelOrRescheduleProtocol: CancelOrRescheduleProtocolZ.nullable(),
  postBookingNotices: PostBookingNoticesZ,
  questionRubric: z.array(QuestionRubricEntryZ),
  /** One service per entry. */
  servicesExplicitlyNotOfferedInfo: z.array(z.string()),
  commonTermsAndNames: z.string(),
  /** "Extra notes for your receptionist". No caps, deliberately. */
  additionalResponseConfiguration: z.array(z.string()),
};

/**
 * The agent config. Every key is required: a writer that forgets one fails
 * validation instead of silently defaulting it (entity-level fields such as
 * `Employee.role` keep their per-entity defaults). Deliberately absent, because
 * they are derived or replaced: receptionistEmployeeDetailLevel,
 * singleEmployeeMode, businessWebsiteAsSpoken, promptType, sendPhotoOnBooking,
 * postBookingLinkSpeechOverride, referenceCancellationPolicyOnBooking,
 * cancellationPolicy. No alternate names either.
 *
 * Cross-field rules (at least one employee, the employee limit, …) are not
 * here: a draft may break them. See `agentConfigPublishable.ts`.
 */
export const AgentConfigZ = z.object({
  ...agentConfigContentShape,
  ...agentConfigSettingsShape,
  ...agentConfigAdditionsShape,
});
export type AgentConfig = z.infer<typeof AgentConfigZ>;
export type AgentConfigInput = z.input<typeof AgentConfigZ>;
export type AgentConfigKey = keyof AgentConfig;

/** Every top-level key, in schema order. Pinned by a test in each repo. */
export const AGENT_CONFIG_KEYS = AgentConfigZ.keyof().options;

// ---------------------------------------------------------------------------
// The voice catalog: the voices on offer and what each supports. Per-environment
// deploy config (`RETELL_VOICE_CATALOG`, read only by bdai-mvp-ui-1), defined
// here because the publish rules check a config against it. Display data (name,
// gender, accent, preview URL) comes from Retell's voice list, not from here.
// Order is picker order; the first entry is the default voice, and the first
// multilingual entry is the default while multilingual is on.
// ---------------------------------------------------------------------------

export const VoiceCatalogEntryZ = z
  .object({
    voiceId: z.string().min(1),
    /** Can speak the multilingual locales (with `voiceModel`, when one is pinned). */
    multilingual: z.boolean(),
    /** Whether `voice_temperature` has any effect for this voice's provider. */
    supportsDeliveryTone: z.boolean(),
    /** A TTS model to pin when this voice is used. Absent: Retell chooses. */
    voiceModel: VoiceModelZ.optional(),
  })
  .strict();
export type VoiceCatalogEntry = z.infer<typeof VoiceCatalogEntryZ>;

export const VoiceCatalogZ = z
  .array(VoiceCatalogEntryZ)
  .min(1, 'The voice catalog must list at least one voice')
  .refine((entries) => entries.some((entry) => entry.multilingual), 'The voice catalog must list at least one multilingual voice')
  .refine(
    (entries) => new Set(entries.map((entry) => entry.voiceId)).size === entries.length,
    'The voice catalog lists a voice more than once',
  );
export type VoiceCatalog = z.infer<typeof VoiceCatalogZ>;

export function findCatalogVoice(catalog: VoiceCatalog, voiceId: string): VoiceCatalogEntry | undefined {
  return catalog.find((entry) => entry.voiceId === voiceId);
}

/** The default voice: the first multilingual entry while multilingual is on, else the first entry. */
export function defaultCatalogVoice(catalog: VoiceCatalog, multilingual: boolean): VoiceCatalogEntry {
  return (multilingual ? catalog.find((entry) => entry.multilingual) : undefined) ?? catalog[0]!;
}

/** The config fields that picking `entry` sets. They always change together. */
export function voiceSelection(entry: VoiceCatalogEntry): Pick<AgentConfig, 'voiceId' | 'voiceModel'> {
  return { voiceId: entry.voiceId, voiceModel: entry.voiceModel ?? null };
}

/**
 * A config's voice and sound settings before a voice is chosen: no voice yet
 * ('', which the UI backend fills with the catalog default when it writes the
 * config, `withDefaultVoice`) and Retell's defaults for the rest.
 */
export const UNSET_VOICE_SETTINGS = {
  voiceId: '',
  voiceModel: null,
  voiceSpeed: DEFAULT_VOICE_SPEED,
  voiceTemperature: DEFAULT_VOICE_TEMPERATURE,
  ambientSound: null,
  ambientSoundVolume: DEFAULT_AMBIENT_SOUND_VOLUME,
} as const satisfies Pick<
  AgentConfig,
  'voiceId' | 'voiceModel' | 'voiceSpeed' | 'voiceTemperature' | 'ambientSound' | 'ambientSoundVolume'
>;

// ---------------------------------------------------------------------------
// Wire contracts for bdai-mvp-1's structured-config routes and the tool steer
// (bdai-mvp-1's docs/architecture/integration-points.md holds the invariants).
// ---------------------------------------------------------------------------

/** `live`: the phone-connected agent. `test`: the web-test agent. */
export const AgentConfigSlotZ = z.enum(['live', 'test']);
export type AgentConfigSlot = z.infer<typeof AgentConfigSlotZ>;

/** POST …/structured-config: writes the `live` row whole, then bakes. */
export const PublishAgentConfigRequestZ = z.object({
  versionId: z.string().min(1),
  agentConfig: AgentConfigZ,
});
export type PublishAgentConfigRequest = z.infer<typeof PublishAgentConfigRequestZ>;

/** POST …/test-config: writes the `test` row whole, then bakes the test agent. */
export const TestAgentConfigRequestZ = z.object({
  agentConfig: AgentConfigZ,
});
export type TestAgentConfigRequest = z.infer<typeof TestAgentConfigRequestZ>;

/** POST …/rebake: the body is optional; no body (or no `target`) means `live`. */
export const RebakeRequestZ = z
  .object({
    target: AgentConfigSlotZ.default('live'),
  })
  .default({});
export type RebakeRequest = z.infer<typeof RebakeRequestZ>;

/** GET …/agent-config?slot=live|test: 200 body (404 when the slot has no row). */
export const AgentConfigRowResponseZ = z.object({
  slot: AgentConfigSlotZ,
  /** Set on the `live` row by publish; null on `test`. */
  publishedVersionId: z.string().nullable(),
  updatedAt: z.string(),
  agentConfig: AgentConfigZ,
});
export type AgentConfigRowResponse = z.infer<typeof AgentConfigRowResponseZ>;

/**
 * The tool steer. Structured agents' tools carry it as static query
 * parameters (`?config=structured&slot=live|test`); SMS, the web-test chat and
 * the internal hops send the same two fields in the request body. Absent means
 * unsteered (legacy agents): the loader decides from the `live` row.
 */
export const AgentConfigSteerZ = z.object({
  config: z.literal('structured'),
  slot: AgentConfigSlotZ,
});
export type AgentConfigSteer = z.infer<typeof AgentConfigSteerZ>;

// ---------------------------------------------------------------------------
// Extraction output: `.pick()`s of the content keys. These replace the
// StructuredAiConfig-based extraction results. Extraction never produces
// holidays, `servicesNotOffered`, `questionRubric`, `consultationInformation`,
// `servicesExplicitlyNotOfferedInfo` or `commonTermsAndNames`; legacy
// conversion adds those deterministically and returns a full `AgentConfigZ`.
// ---------------------------------------------------------------------------

/** The content keys extraction produces. */
export const ExtractedAgentContentZ = AgentConfigZ.pick({
  employees: true,
  services: true,
  policies: true,
  faq: true,
  businessHours: true,
  location: true,
});
export type ExtractedAgentContent = z.infer<typeof ExtractedAgentContentZ>;

/** LLM-facing employee shape: no id (assigned after extraction), no servicesNotOffered. */
export const AgentConfigEmployeeExtractionZ = AgentConfigEmployeeZ.omit({ id: true, servicesNotOffered: true });

/**
 * Job result of the legacy flat → structured conversion (`sourceType: 'legacy'`).
 * Unlike the other extraction results this is the WHOLE agent config: the
 * extracted content plus every setting carried over from the legacy row
 * (`legacyToAgentConfig`), which the UI writes into the DRAFT as is. `warnings`
 * lists what could not be carried over (unmatched employee exclusions, past
 * holidays, unparseable legacy values).
 */
export const AgentContentFullConfigExtractionResultZ = z.object({
  entityType: z.literal('fullConfig'),
  structuredConfig: AgentConfigZ,
  warnings: z.array(z.string()),
});
export type AgentContentFullConfigExtractionResult = z.infer<typeof AgentContentFullConfigExtractionResultZ>;

/** Job result of a bootstrap extraction (`sourceType: 'bootstrap'`). */
export const AgentContentBootstrapExtractionResultZ = z.object({
  entityType: z.literal('bootstrap'),
  structuredData: ExtractedAgentContentZ,
  discoveredUrls: z.array(DiscoveredUrlZ),
  businessTimeZone: z.string().optional(),
  warnings: z.array(z.string()),
  websiteDiscoveryMocked: z.boolean().optional(),
});
export type AgentContentBootstrapExtractionResult = z.infer<typeof AgentContentBootstrapExtractionResultZ>;

/** Every extraction job result, per-entity ones included. */
export const AgentContentExtractionResultZ = z.discriminatedUnion('entityType', [
  z.object({ entityType: z.literal('employees'), entities: z.array(AgentConfigEmployeeZ) }),
  z.object({ entityType: z.literal('services'), entities: z.array(ServiceZ) }),
  z.object({ entityType: z.literal('policies'), entities: z.array(PolicyZ) }),
  z.object({ entityType: z.literal('faq'), entities: z.array(FaqEntryZ) }),
  z.object({
    entityType: z.literal('general'),
    businessHours: z.array(BusinessHoursEntryZ),
    location: BusinessLocationZ,
  }),
  AgentContentFullConfigExtractionResultZ,
  AgentContentBootstrapExtractionResultZ,
]);
export type AgentContentExtractionResult = z.infer<typeof AgentContentExtractionResultZ>;
