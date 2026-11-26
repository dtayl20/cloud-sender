export function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function rowsOf<T = any>(data: unknown): T[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  return asArray<T>((data as { rows?: unknown }).rows);
}

export function fieldArray<T = any>(data: unknown, field: string): T[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  return asArray<T>((data as Record<string, unknown>)[field]);
}

export function errorOf(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" ? error : error ? JSON.stringify(error) : "";
}