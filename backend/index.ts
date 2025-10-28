// import express from "express";
// import { PrismaClient } from "./prisma/generated/client";
// import redisClient from "./redisClient";

// const PORT = 4005;
// const app = express();
// const prisma = new PrismaClient();
// const CACHE_TTL = 60;

// app.use(express.json());


// app.get("/users", async (req, res) => {
//     try {
//     const users = await prisma.user.findMany();
//     return res.json(users);
//     } catch (error) {
//         console.error("Error fetching users:", error);
//         return res.status(500).json({ error: "Internal server error" });
//     }
// });

// app.get("/users/:id", async (req, res) => {
//     try {
//      const { id } = req.params;
//      const cacheKey = `user:${id}`;
//      const cacheUser = await redisClient.get(cacheKey);
//      if (cacheUser) {
//         console.log(`User ${id} fetched from cache`);
//         return res.json(
//             {
//                 source: 'cache',
//                 data: JSON.parse(cacheUser)
//             }
//         );
//      }
//     const user = await prisma.user.findUnique({ 
//         where: { 
//             id: Number(id) 
//         } 
//     });
//     if (!user) {
//         return res.status(404).json({ error: "User not found" });
//     }
//     await redisClient.setex(cacheKey, CACHE_TTL, JSON.stringify(user));
//     console.log(`User ${id} fetched from DB`);
//     return res.json(
//         {
//             source: 'db',
//             data: user
//         }
//     );   
//     } catch (error) {
//         console.error("Error fetching user:", error);
//         return res.status(500).json({ error: "Internal server error" });
//     }
// });

// app.delete("/cache/users/:id", async (req, res) => {
//   try {
//     const { id } = req.params;
//     const cacheKey = `user:${id}`;
//     const result = await redisClient.del(cacheKey);

//     if (result === 1) {
//       console.log(`✅ Cache cleared for user ${id}`);
//       return res.json({ message: `Cache cleared for user ${id}` });
//     } else {
//       console.log(`⚠️ No cache entry found for user ${id}`);
//       return res.status(404).json({ message: `No cache found for user ${id}` });
//     }
//   } catch (error) {
//     console.error("Error deleting cache:", error);
//     return res.status(500).json({ error: "Internal server error" });
//   }
// });


// app.listen(PORT, () => {
//     console.log(`Server is running on port ${PORT}`);
// });


import express from "express";
import { PrismaClient } from "./prisma/generated/client";
import redisClient, { redlock } from "./redisClient";

const PORT = 4005;
const app = express();
const prisma = new PrismaClient();
const CACHE_TTL = 30;

app.use(express.json());

// INSTRUMENTATION - ADD THIS
let dbQueryCount = 0;
let cacheHits = 0;
let cacheMisses = 0;

app.get("/users", async (req, res) => {
    try {
    const users = await prisma.user.findMany();
    return res.json(users);
    } catch (error) {
        console.error("Error fetching users:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/users/:id", async (req, res) => {
  const startTime = Date.now();
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    return res.status(400).json({ error: "Invalid user ID" });
  }
  const cacheKey = `user:${id}`;
  const lockKey = `locks:${cacheKey}`;
  let lock;

  try {
    // Step 1 — check cache first
    const cachedUser = await redisClient.get(cacheKey);
    if (cachedUser) {
      cacheHits++;
      console.log(`[CACHE HIT #${cacheHits}] User ${id}`);
      return res.json({ source: "cache", data: JSON.parse(cachedUser) });
    }

    // Step 2 — try to acquire lock
    try {
      lock = await redlock.acquire([lockKey], 5000);
      console.log(`🔒 Lock acquired for user ${id}`);

      // Step 3 — double-check cache after acquiring lock
      const cachedAgain = await redisClient.get(cacheKey);
      if (cachedAgain) {
        cacheHits++;
        console.log(`[CACHE HIT (after lock) #${cacheHits}] User ${id}`);
        return res.json({
          source: "cache_after_lock",
          data: JSON.parse(cachedAgain),
        });
      }

      // Step 4 — perform DB query
      cacheMisses++;
      dbQueryCount++;
      const queryId = dbQueryCount;
      console.log(`[DB QUERY #${queryId}] User ${id} - STARTED`);

      await new Promise((resolve) => setTimeout(resolve, 50)); // simulate DB latency
      const user = await prisma.user.findUnique({
        where: { id: Number(id) },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      await redisClient.setex(cacheKey, CACHE_TTL, JSON.stringify(user));

      const queryTime = Date.now() - startTime;
      console.log(`[DB QUERY #${queryId}] User ${id} - COMPLETED in ${queryTime}ms`);

      return res.json({ source: "db", data: user });
    } catch (lockErr) {
      // Step 5 — someone else has the lock
      console.log(`⏳ Waiting for cache fill for user ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const cachedAfterWait = await redisClient.get(cacheKey);
      if (cachedAfterWait) {
        cacheHits++;
        console.log(`[CACHE HIT (after wait) #${cacheHits}] User ${id}`);
        return res.json({
          source: "cache_after_wait",
          data: JSON.parse(cachedAfterWait),
        });
      }

      // fallback: do the DB query if cache still empty
      cacheMisses++;
      const user = await prisma.user.findUnique({ where: { id: Number(id) } });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      await redisClient.setex(cacheKey, CACHE_TTL, JSON.stringify(user));
      return res.json({ source: "db_no_lock", data: user });
    } finally {
      // Step 6 — release lock using redlock.release()
      if (lock) {
        try {
          await redlock.release(lock);
          console.log(`🔓 Lock released for user ${id}`);
        } catch (releaseErr) {
          console.warn(`⚠️ Failed to release lock for user ${id}`, releaseErr);
        }
      }
    }
  } catch (error) {
    console.error("❌ Error fetching user:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// STATS ENDPOINT - CRITICAL
app.get("/stats", (req, res) => {
  res.json({ 
    dbQueries: dbQueryCount,
    cacheHits,
    cacheMisses,
    message: cacheMisses > 0 && dbQueryCount > 1 
      ? `⚠️ THUNDERING HERD DETECTED: ${dbQueryCount} queries for ${cacheMisses} cache miss(es)`
      : "✅ No thundering herd detected"
  });
});

// RESET STATS - FOR TESTING
app.post("/stats/reset", (req, res) => {
  dbQueryCount = 0;
  cacheHits = 0;
  cacheMisses = 0;
  res.json({ message: "Stats reset" });
});

// CACHE DELETE - FIX YOUR ROUTE
app.delete("/cache/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `user:${id}`;
    const result = await redisClient.del(cacheKey);

    if (result === 1) {
      console.log(`✅ Cache cleared for user ${id}`);
      return res.json({ message: `Cache cleared for user ${id}` });
    } else {
      console.log(`⚠️ No cache entry found for user ${id}`);
      return res.status(404).json({ message: `No cache found for user ${id}` });
    }
  } catch (error) {
    console.error("Error deleting cache:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});