import { spawn } from "node:child_process";

// No shell interpretation. Kill the process group so pipelines/grandchildren do
// not outlive a timed-out request. These limits apply before output is retained.
export function executeCli(executable, args, { cwd, env, timeoutMs, maxBuffer = 1_000_000 }) {
  return new Promise(resolve => {
    let child, timer, reason = "", total = 0;
    const out = [], err = [];
    const stop = status => {
      if (reason) return;
      reason = status;
      if (!child?.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    try {
      child = spawn(executable, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      timer = setTimeout(() => stop("cli_timeout"), timeoutMs);
      const collect = target => chunk => {
        const remaining = Math.max(0, maxBuffer - total);
        if (remaining) target.push(chunk.subarray(0, remaining));
        total += chunk.length;
        if (total > maxBuffer) stop("output_limit_exceeded");
      };
      child.stdout.on("data", collect(out));
      child.stderr.on("data", collect(err));
      child.on("error", error => { reason ||= error.code === "ENOENT" ? "cli_not_installed" : "cli_spawn_failed"; });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ ok: !reason && code === 0, status: reason || (code === 0 ? "ok" : "cli_failed"), exit_code: code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
    } catch {
      clearTimeout(timer);
      resolve({ ok: false, status: "cli_spawn_failed", exit_code: null, stdout: "", stderr: "" });
    }
  });
}
