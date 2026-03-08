function stamp(): string {
  return new Date().toISOString();
}

function format(level: string, message: string): string {
  return `[${stamp()}] [${level}] ${message}`;
}

export const logger = {
  info(message: string): void {
    console.log(format("INFO", message));
  },
  warn(message: string): void {
    console.warn(format("WARN", message));
  },
  error(message: string): void {
    console.error(format("ERROR", message));
  }
};
