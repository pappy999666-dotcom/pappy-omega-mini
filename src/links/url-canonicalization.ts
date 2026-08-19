export function canonicalizeHttpUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (!/^https?:$/.test(parsed.protocol))
    throw new Error("Preview URLs must use HTTP or HTTPS.");
  if (parsed.username || parsed.password)
    throw new Error("Preview URLs cannot contain credentials.");
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";
  if (
    parsed.hostname === "chat.whatsapp.com" &&
    /^\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)
  ) {
    const inviteCode = parsed.pathname.split("/").filter(Boolean)[0];
    parsed.pathname = `/${inviteCode}`;
    parsed.search = "";
  }
  return parsed.toString();
}
