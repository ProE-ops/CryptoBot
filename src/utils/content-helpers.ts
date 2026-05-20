const FALLBACK_TAGS = ["#Crypto", "#Web3", "#BTC"];

function extractHashtags(text: string): string[] {
  const matches = text.match(/[#$][A-Za-z][A-Za-z0-9_]*/g) || [];
  return [...new Set(matches)];
}

/** Append hashtags to end of tweet text, deduplicating any already inline. */
export function appendHashtags(tweetText: string, hashtags: string[]): string {
  if (!tweetText) return tweetText;
  const tags = hashtags.length > 0 ? hashtags : (extractHashtags(tweetText) || FALLBACK_TAGS);
  const body = tweetText.trimEnd().replace(/(\s+[#$][A-Za-z][A-Za-z0-9_]*)+$/, "").trimEnd();
  return body + "\n\n" + tags.join(" ");
}
