import { z } from 'zod';

// The setting enums the agent config uses (subset of comms' fieldDefinitions.ts).
export const ServiceBookingStyleZod = z.enum(['alaCarte', 'hourlyAllInclusive', 'specificServicesOnly']);
export const ConsultationProtocolZod = z.enum(['escalateToOwner', 'findConsultationAvailability', 'guessBestService']);
export const MultilingualVersionZod = z.enum(['v1', 'v2']);
