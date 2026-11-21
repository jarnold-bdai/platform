import { z } from "zod";

export const CancelOrRescheduleProtocolZod = z.object({
  protocol: z.literal("customTextMessage"),
  customMessage: z.string(),
});

export type CancelOrRescheduleProtocol = z.infer<
  typeof CancelOrRescheduleProtocolZod
>;
