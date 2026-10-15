import type { Subprocess } from "bun";
import type { AppConfig } from "../../src/shared/config";
import { configToEnv } from "./env";

/** A real, separate OS process running src/main.ts (one "instance" of the service). */
export class Instance {
  private constructor(
    readonly id: string,
    readonly port: number,
    readonly proc: Subprocess,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  static async start(
    config: AppConfig,
    port: number,
    id: string,
    extraEnv: Record<string, string> = {},
    { waitReady = true } = {},
  ): Promise<Instance> {
    const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, ...configToEnv(config, port, id), ...extraEnv },
      stdout: process.env.TEST_INSTANCE_STDOUT ? "inherit" : "ignore",
      stderr: process.env.TEST_INSTANCE_STDOUT ? "inherit" : "ignore",
    });
    const instance = new Instance(id, port, proc);
    if (waitReady) await instance.waitReady();
    return instance;
  }

  async waitReady(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) throw new Error(`instance ${this.id} exited with ${this.proc.exitCode}`);
      try {
        const res = await fetch(`${this.url}/health/ready`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await Bun.sleep(150);
    }
    throw new Error(`instance ${this.id} not ready after ${timeoutMs}ms`);
  }

  /** SIGTERM = graceful; SIGKILL = crash. */
  async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<number | null> {
    if (this.proc.exitCode === null) this.proc.kill(signal);
    await this.proc.exited;
    return this.proc.exitCode;
  }

  async post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  async get(path: string) {
    const res = await fetch(`${this.url}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }
}

export function freePorts(count: number, base = 3100 + Math.floor(Math.random() * 800)): number[] {
  return Array.from({ length: count }, (_, i) => base + i);
}
