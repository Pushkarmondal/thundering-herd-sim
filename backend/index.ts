import express from "express";
import { PrismaClient } from "./prisma/generated/client";

const PORT = 4005;
const app = express();
const prisma = new PrismaClient();

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
    const user = await prisma.user.findUnique({ 
        where: { 
            id: Number(id) 
        } 
    });
    if (!user) {
        return res.status(404).json({ error: "User not found" });
    }
    return res.json(user);   
    } catch (error) {
        console.error("Error fetching user:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
