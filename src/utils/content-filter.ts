/**
 * Filter out low-quality KOL posts BEFORE they enter the synthesis queue.
 * Goal: don't waste AI tokens on shilling, link spam, or 1-line emoji posts.
 */

// Common shilling / spam vocabulary in crypto KOL posts
const SHILL_PATTERNS = [
  /\bairdrop\b/i,
  /\bwhitelist\b/i,
  /\bjoin (my|our|the) (telegram|discord|group)\b/i,
  /\b(100x|1000x) (gem|moonshot|opportunity)\b/i,
  /\b(buy now|don'?t miss|last chance)\b/i,
  /\bdm me\b/i,
  /\bcheck (my )?bio\b/i,
  /\bpresale (live|open)\b/i,
  /\bfree (mint|nft|tokens)\b/i,
  /\bgiveaway\b/i,
];

// Pure noise patterns
const NOISE_PATTERNS = [
  /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\s]+$/u,        // pure emoji
  /^(gm|gn|wagmi|lfg|lol|lmao|🚀+|🔥+)\s*[!.]*\s*$/i,    // 1-word chats
  /^(thanks|thank you|nice|good)\b.*$/i,                  // generic reaction
];

export interface FilterResult {
  pass: boolean;
  reason?: string;
}

/**
 * Returns { pass: false, reason } if the content should be SKIPPED at crawler level.
 * Returns { pass: true } if it's worth saving as a pending KOL item.
 */
export function filterKolContent(rawText: string): FilterResult {
  const text = rawText.trim();

  // Length checks
  if (text.length < 50)   return { pass: false, reason: "too short" };
  if (text.length > 5000) return { pass: false, reason: "too long (likely article paste)" };

  // Link density — posts that are >40% links are spam
  const links = text.match(/https?:\/\/\S+/g) || [];
  const linkCharCount = links.join("").length;
  if (links.length > 4)                            return { pass: false, reason: "link spam (>4 URLs)" };
  if (linkCharCount / text.length > 0.4)           return { pass: false, reason: "mostly links" };

  // Noise patterns (whole-text match)
  for (const re of NOISE_PATTERNS) {
    if (re.test(text)) return { pass: false, reason: "noise (chat/emoji-only)" };
  }

  // Shilling vocabulary — needs at least 2 matches to skip (single match could be legitimate news)
  let shillHits = 0;
  for (const re of SHILL_PATTERNS) {
    if (re.test(text)) shillHits++;
    if (shillHits >= 2) return { pass: false, reason: "shilling vocabulary" };
  }

  // Mostly-mention spam (>5 @handles in a short post)
  const mentions = text.match(/@\w+/g) || [];
  if (mentions.length > 5 && text.length < 500) {
    return { pass: false, reason: "mention spam" };
  }

  // Mostly-cashtag pumping ($XYZ $ABC $DEF $... — likely shill list)
  const cashtags = text.match(/\$[A-Z]{2,10}\b/g) || [];
  if (cashtags.length > 6) return { pass: false, reason: "cashtag spam" };

  return { pass: true };
}
