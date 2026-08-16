import { spawn } from "node:child_process";

const services = [
  "services/proxy/src/index.ts",
  "services/web/src/index.ts",
] as const;

const children = services.map((entry) =>
  spawn(
    process.execPath,
    ["--env-file-if-exists=.env", "--watch", "--import", "tsx", entry],
    { stdio: "inherit" },
  ),
);

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

for (const child of children) {
  child.on("exit", (code) => {
    if (code !== null && code !== 0) shutdown(code);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
