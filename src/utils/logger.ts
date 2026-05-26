import { db } from "../db.js";

type LogLevel = "info" | "warn" | "error" | "debug";

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(level: LogLevel, module: string, message: string): void {
  const line = `[${timestamp()}] [${level.toUpperCase()}] [${module}] ${message}`;
  console.log(line);

  // Only persist WARN/ERROR to DB — INFO/DEBUG are console-only.
  // Avoids millions of rows from high-frequency crawl polling.
  if (level === "warn" || level === "error") {
    db.log.create({ data: { level, module, message } }).catch(() => {});
  }
}

export const logger = {
  info:  (module: string, message: string) => log("info",  module, message),
  warn:  (module: string, message: string) => log("warn",  module, message),
  error: (module: string, message: string) => log("error", module, message),
  debug: (module: string, message: string) => log("debug", module, message),
};
