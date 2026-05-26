import { PrismaClient } from "@prisma/client";

// SQLite: single connection, 30s timeout, WAL mode for concurrent reads
export const db = new PrismaClient({
  datasources: {
    db: {
      url: `${process.env.DATABASE_URL || "file:../data/crypto-bot.db"}?connection_limit=1&socket_timeout=30`,
    },
  },
});
