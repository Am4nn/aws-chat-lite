import { ValidationError } from "../lib/errors.js";

export function titleOf(raw: unknown): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (title.length < 1 || title.length > 40) throw new ValidationError("Schedule titles are 1 to 40 characters.");
  return title;
}

export function promptOf(raw: unknown): string {
  const prompt = typeof raw === "string" ? raw.trim() : "";
  if (prompt.length < 1 || prompt.length > 2000) throw new ValidationError("A schedule's prompt is 1 to 2,000 characters.");
  return prompt;
}

export function enabledOf(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new ValidationError("enabled must be true or false.");
  return raw;
}
