/*
  MAMISHI AI smart search patch
  Copy this function into server.js and replace the existing shouldAutoSearch().
  It expects these existing helpers/constants in server.js:
  - tavilyClient
  - BS.tavily
  - isFounderQuery(messages)
  - getEffectiveUserText(messages)
  - isCorrectionMessage(text)
  - hasDetailedUserContext(text)
*/

function shouldAutoSearch(messages) {
  if (!tavilyClient && !BS.tavily.on) return false;
  if (isFounderQuery(messages)) return false;

  const rawText = String(getEffectiveUserText(messages) || "").trim();
  const text = rawText.toLowerCase();
  if (!text) return false;
  if (isCorrectionMessage(text) && hasDetailedUserContext(text)) return false;

  const entityLookup = [
    "who is",
    "who are",
    "who was",
    "who were",
    "tell me about",
    "what is",
    "what are",
    "when did",
    "when was",
    "when is",
    "where is",
    "where are",
    "how much is",
    "how many",
    "what happened",
    "what happened to",
    "define ",
    "explain ",
  ].some(term => text.startsWith(term) || text.includes(" " + term));

  const properNounLookup =
    /(^|\s)(who|what|when|where|tell|define|explain)\b/i.test(rawText) &&
    /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(rawText);

  if (entityLookup || properNounLookup) return true;

  return [
    "latest",
    "current",
    "today",
    "tonight",
    "recent",
    "result",
    "results",
    "score",
    "scores",
    "price",
    "prices",
    "weather",
    "news",
    "update",
    "updates",
    "exchange",
    "rate",
    "rates",
    "conversion",
    "convert",
    "currency",
    "usd",
    "zar",
    "eur",
    "gbp",
    "draw",
    "jackpot",
    "lotto",
    "loto",
    "powerball",
  ].some(term => text.includes(term));
}
