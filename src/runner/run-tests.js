// Runs the user's test command and collects its output. A non-zero exit is a
// normal outcome here (that is why we are running), so it is reported rather
// than thrown; only the caller decides what a failure means.
import { spawn } from 'node:child_process';

export function runTests(command, { cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, { shell: true, cwd });
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ exitCode: -1, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}
