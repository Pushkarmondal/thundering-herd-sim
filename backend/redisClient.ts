import Redis from "ioredis";
import Redlock from "redlock";

const redisClient = new Redis("redis://localhost:6379");

const redlock = new Redlock(
    [redisClient as any],
    {
        driftFactor: 0.01,
        retryCount: 3,
        retryDelay: 200,
        retryJitter: 100,
    }
);

export default redisClient;
export { redlock };
