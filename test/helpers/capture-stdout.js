// Captures everything written to process.stdout.write for the duration of
// `fn`, then restores the original. Used by the per-injection-path marker
// tests (issue #21) to prove a writer actually printed a valid marker line,
// without spawning a real child process - the same unit-test style the
// existing inject-*.test.js files already use for the ack-file side.
import { parseMarkers } from '../../src/inject/shared/marker.js';

export async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  process.stdout.write = (chunk, ...rest) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString();
    // Preserve normal stdout behavior (callbacks, backpressure signal) by
    // still forwarding to the real write - tests still want to see their
    // own console output if they fail.
    return original(chunk, ...rest);
  };
  try {
    const result = await fn();
    return { result, stdout: buffer, markers: parseMarkers(buffer) };
  } finally {
    process.stdout.write = original;
  }
}
