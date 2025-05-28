import { z } from "zod";

export default z.object({
  BOT_TOKEN: z.string(),
  REDIS_HOST: z.string(),
}).parse(process.env);