// Started only by the package's flock-protected write runner. Reads and context
// never require a child process. The kernel releases the lock after a crash.
import { publish, type Intent } from "./store.ts";
let input = "";
try {
  for await (const chunk of process.stdin) input += chunk;
  const intent = JSON.parse(input) as Intent;
  const entry = await publish(intent);
  process.stdout.write(JSON.stringify({ entry }) + "\n");
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: (error as Error).message, pending: true }) + "\n",
  );
}
