const PATTERNS = [
  /\b(?:code|passcode|otp|pin|one[\s-]?time password)\b(?:\s+is)?\s*[:=]?\s*\(?(G-\d{4,8}|\d{3}[\s-]\d{3}|\d{4,8})(?!\d)/i,
  /(?<!\d)(G-\d{4,8}|\d{4,8})(?!\d)\s+is\s+your\b[^.\n]{0,30}?\b(?:code|passcode|otp|pin)\b/i,
];

export function detect2fa(text: string): { codes: string[]; notify: boolean } {
  const codes: string[] = [];
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m?.[1]) codes.push(m[1].replace(/\s|-/g, ""));
  }
  return { codes: [...new Set(codes)], notify: codes.length > 0 };
}
