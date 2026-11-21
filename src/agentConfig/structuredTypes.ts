import { z } from 'zod';

// ============================================================================
// Structured AI Config types: the subset the agent config schema imports.
// ============================================================================

export const ProvenanceZ = z.object({
  importedFrom: z.enum(['url', 'square', 'legacy']),
  sourceUrl: z.string().url().optional(),
  importedAt: z.string().datetime(),
});
export type Provenance = z.infer<typeof ProvenanceZ>;

export const EmployeeZ = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  role: z.string().default(''),
  specialties: z.array(z.string()).default([]),
  bio: z.string().default(''),
  scheduleNotes: z.string().default(''),
  provenance: ProvenanceZ.optional(),
});
export type Employee = z.infer<typeof EmployeeZ>;

export const ServiceZ = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  description: z.string().default(''),
  duration: z.string().default(''),
  price: z.string().default(''),
  category: z.string().default(''),
  provenance: ProvenanceZ.optional(),
});
export type Service = z.infer<typeof ServiceZ>;

export const PolicyZ = z.object({
  id: z.string(),
  title: z.string().min(1, 'Title is required'),
  description: z.string().default(''),
  category: z.enum(['cancellation', 'booking', 'payment', 'general']).default('general'),
  provenance: ProvenanceZ.optional(),
});
export type Policy = z.infer<typeof PolicyZ>;

export const FaqEntryZ = z.object({
  id: z.string(),
  question: z.string().min(1, 'Question is required'),
  answer: z.string().min(1, 'Answer is required'),
  provenance: ProvenanceZ.optional(),
});
export type FaqEntry = z.infer<typeof FaqEntryZ>;

export const DAYS_OF_WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export const DayOfWeekZ = z.enum(DAYS_OF_WEEK);
export type DayOfWeek = z.infer<typeof DayOfWeekZ>;

export const BusinessHoursEntryZ = z.object({
  day: DayOfWeekZ,
  open: z.string().default('09:00'),
  close: z.string().default('17:00'),
  closed: z.boolean().default(false),
  provenance: ProvenanceZ.optional(),
});
export type BusinessHoursEntry = z.infer<typeof BusinessHoursEntryZ>;

export const BusinessLocationZ = z.object({
  address: z.string().default(''),
  city: z.string().default(''),
  state: z.string().default(''),
  zip: z.string().default(''),
  parkingInfo: z.string().default(''),
  accessibilityNotes: z.string().default(''),
  provenance: ProvenanceZ.optional(),
});
export type BusinessLocation = z.infer<typeof BusinessLocationZ>;

export const StructuredAiConfigZ = z.object({
  employees: z.array(EmployeeZ),
  services: z.array(ServiceZ),
  policies: z.array(PolicyZ),
  faq: z.array(FaqEntryZ),
  businessHours: z.array(BusinessHoursEntryZ),
  location: BusinessLocationZ,
});
export type StructuredAiConfig = z.infer<typeof StructuredAiConfigZ>;

export const DiscoveredUrlZ = z.object({
  url: z.string(),
  categories: z.array(z.string()),
  confidence: z.number(),
});
export type DiscoveredUrl = z.infer<typeof DiscoveredUrlZ>;
