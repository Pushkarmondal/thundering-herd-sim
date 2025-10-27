import { PrismaClient } from './generated/client';
const prisma = new PrismaClient();

async function main() {
  const users = Array.from({ length: 1000 }, (_, i) => ({
    name: `User ${i + 1}`
  }));

  console.time("Insert 1k users");
  await prisma.user.createMany({
    data: users,
    skipDuplicates: true,
  });
  console.timeEnd("Insert 1k users");
}

main()
  .then(() => {
    console.log("✅ 1000 users inserted");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
