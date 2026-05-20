/**
 * Migration: clean legacy source handles in DB.
 * Old sources may have full URLs stored as handle (added before parseSourceInput).
 * Run: pnpm tsx scripts/clean-sources.ts
 */

import { db } from "../src/db.js";

function parseTwitter(raw: string): string | null {
  const m = raw.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
  const candidate = m ? m[1] : raw.replace(/^@/, "").trim();
  return /^[A-Za-z0-9_]{1,15}$/.test(candidate) ? candidate : null;
}

function parseTelegram(raw: string): string | null {
  const invite = raw.match(/t\.me\/(?:joinchat\/|joinchat\?|\+)([A-Za-z0-9_-]+)/i);
  if (invite) return "+" + invite[1];
  const pub = raw.match(/t\.me\/([A-Za-z0-9_]{3,})/i);
  if (pub) return "@" + pub[1];
  if (raw.startsWith("@") && /^@[A-Za-z0-9_]{3,}$/.test(raw)) return raw;
  if (/^[A-Za-z0-9_]{3,}$/.test(raw)) return "@" + raw;
  return null;
}

async function main() {
  const sources = await db.source.findMany();
  console.log(`Scanning ${sources.length} sources...`);

  let cleaned = 0;
  let invalid = 0;
  const dups: { keep: string; remove: string[] }[] = [];

  for (const s of sources) {
    const parsed = s.type === "twitter" ? parseTwitter(s.handle) : parseTelegram(s.handle);

    if (!parsed) {
      console.log(`❌ INVALID: ${s.type} "${s.handle}" — marking inactive`);
      await db.source.update({ where: { id: s.id }, data: { isActive: false } });
      invalid++;
      continue;
    }

    if (parsed === s.handle) continue;  // already clean

    // Check if cleaned handle would collide with existing
    const existing = await db.source.findFirst({
      where: { type: s.type, handle: parsed, id: { not: s.id } },
    });

    if (existing) {
      console.log(`⚠️ DUPLICATE: "${s.handle}" → "${parsed}" already exists (id=${existing.id.slice(0, 8)})`);
      // Keep the older one, deactivate this
      await db.source.update({ where: { id: s.id }, data: { isActive: false } });
      dups.push({ keep: existing.handle, remove: [s.handle] });
      continue;
    }

    console.log(`✅ FIX: "${s.handle}" → "${parsed}"`);
    await db.source.update({ where: { id: s.id }, data: { handle: parsed, name: parsed } });
    cleaned++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Cleaned:    ${cleaned}`);
  console.log(`Invalid:    ${invalid} (deactivated)`);
  console.log(`Duplicates: ${dups.length} (deactivated)`);
  console.log(`Done.`);

  await db.$disconnect();
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
