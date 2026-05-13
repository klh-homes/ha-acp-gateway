import { pino } from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    base: { service: "ha-claude-acp" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
