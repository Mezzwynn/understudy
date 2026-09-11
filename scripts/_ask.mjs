/**
 * _ask.mjs — line reader that works with both an interactive terminal and a
 * piped stdin (readline/promises silently stops after the 2nd question when
 * stdin is a pipe, which breaks scripted use).
 */
import readline from "node:readline";

export function createAsk() {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: Boolean(process.stdin.isTTY),
  });

  const queue = [];
  let waiting = null;
  let closed = false;

  rl.on("line", (line) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(null);
    }
  });

  async function ask(question, def = "") {
    const suffix = def !== "" && def !== undefined && def !== null ? ` [${def}]` : "";
    process.stdout.write(`${question}${suffix}: `);
    let line;
    if (queue.length) line = queue.shift();
    else if (closed) line = null;
    else line = await new Promise((res) => (waiting = res));
    if (line === null) {
      process.stdout.write("\n");
      return def;
    }
    const value = String(line).trim();
    return value === "" ? def : value;
  }

  return {
    ask,
    close() {
      try {
        rl.close();
      } catch {
        /* ignore */
      }
    },
  };
}
