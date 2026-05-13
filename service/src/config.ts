export interface Config {
  port: number;
  logLevel: string;
  bearerToken: string;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

function readRequired(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`${name} must be set`);
  }
  return v;
}

export function loadConfig(): Config {
  return {
    port: readInt("PORT", 8765),
    logLevel: process.env.LOG_LEVEL ?? "info",
    bearerToken: readRequired("BEARER_TOKEN"),
  };
}
