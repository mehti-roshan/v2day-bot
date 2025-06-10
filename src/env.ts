import { z } from "zod";

export default z.object({
  BOT_TOKEN: z.string(),
  REDIS_HOST: z.string(),
  CARD_NUMBER: z.string(),
  BANK_NAME: z.string(),
  CARD_OWNER_NAME: z.string(),
}).parse(process.env);