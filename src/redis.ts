import Redis from "ioredis";
import { env } from "process";

export default new Redis({ host: env.REDIS_HOST });