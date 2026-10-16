import readline from "node:readline";
import { Writable } from "node:stream";

/**
 * Asks for a secret (a pasted connection string, a password) without echoing it. Streams are injectable so it can be tested.
 * Returns "" if the input ends without an answer.
 */
export function askHidden(question: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const quiet = new Writable({ write(chunk, enc, cb) { if (!muted) output.write(chunk, enc as BufferEncoding); cb(); } });
    const rl = readline.createInterface({ input, output: quiet, terminal: true });
    let answered = false;
    output.write(question);
    muted = true;
    rl.on("close", () => { if (!answered) { output.write("\n"); resolve(""); } });
    rl.question("", (a) => { answered = true; muted = false; rl.close(); output.write("\n"); resolve(a.trim()); });
  });
}
