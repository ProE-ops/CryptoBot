import { PrismaClient } from "@prisma/client";

// SQLite: Prisma manages a single connection automatically.
// Disable Prisma's own query/info logging — we use our own logger.
export const db = new PrismaClient({
  log: [],
});
