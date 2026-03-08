import psList from "ps-list";

export interface ProcessProbeResult {
  running: boolean;
  matches: Array<{
    pid: number;
    name: string;
    cmd?: string;
  }>;
}

export async function probeProcess(processName: string): Promise<ProcessProbeResult> {
  const processes = await psList();
  const needle = processName.toLowerCase();

  const matches = processes
    .filter((entry) => {
      const nameHit = entry.name.toLowerCase().includes(needle);
      const cmdHit = (entry.cmd ?? "").toLowerCase().includes(needle);
      return nameHit || cmdHit;
    })
    .map((entry) => ({
      pid: entry.pid,
      name: entry.name,
      cmd: entry.cmd
    }));

  return {
    running: matches.length > 0,
    matches
  };
}
