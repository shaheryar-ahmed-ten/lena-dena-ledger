// Runs the Express API (port 3001) and the Vite dev server (port 5173) together.
import { spawn } from "node:child_process";
const run = (script) => spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], { stdio: "inherit", shell: process.platform === "win32" });
const procs = [run("dev:server"), run("dev:client")];
const stop = () => procs.forEach(p => p.kill());
process.on("SIGINT", stop); process.on("SIGTERM", stop);
