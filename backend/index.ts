import express from "express";
import { PrismaClient } from "./prisma/generated/client";
import redisClient from "./redisClient";

const PORT = 4005;
const app = express();
const prisma = new PrismaClient();
const CACHE_TTL = 30;

app.use(express.json());


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
    try {
     const { id } = req.params;
     const cacheKey = `user:${id}`;
     const cacheUser = await redisClient.get(cacheKey);
     if (cacheUser) {
        console.log(`User ${id} fetched from cache`);
        return res.json(
            {
                source: 'cache',
                data: JSON.parse(cacheUser)
            }
        );
     }
    const user = await prisma.user.findUnique({ 
        where: { 
            id: Number(id) 
        } 
    });
    if (!user) {
        return res.status(404).json({ error: "User not found" });
    }
    await redisClient.setex(cacheKey, CACHE_TTL, JSON.stringify(user));
    console.log(`User ${id} fetched from DB`);
    return res.json(
        {
            source: 'db',
            data: user
        }
    );   
    } catch (error) {
        console.error("Error fetching user:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
