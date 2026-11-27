export const newId = (): string => crypto.randomUUID();
export const normalize = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ');
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
