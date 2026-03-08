export interface HealthProbeResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

export async function probeHealth(url: string, timeoutMs: number): Promise<HealthProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });

    return {
      ok: response.ok,
      statusCode: response.status
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}
