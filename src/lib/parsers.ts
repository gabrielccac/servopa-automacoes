export function decodeEntities(s: string): string {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function stripTags(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePhone(phone: string | null): string | null {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits || null;
}

export function extractInfoBlockValue(html: string, label: string): string | null {
  const regex = new RegExp(
    `<div[^>]*class=["'][^"']*main-info-block-col[^"']*["'][^>]*>\\s*<span>${label}<\\/span>\\s*<strong>([^<]+)<\\/strong>`,
    "i",
  );
  const match = regex.exec(html);
  return match ? stripTags(match[1]) : null;
}
