import { applyChange } from './management.ts';
let raw = '';
try {
  for await (const chunk of process.stdin) raw += chunk;
  const { agentDir, input, guard } = JSON.parse(raw);
  console.log(JSON.stringify(await applyChange(agentDir, input, guard)));
} catch (error) {
  const failure = error as Error & { status?: number };
  console.log(JSON.stringify({ error: failure.message, status: failure.status ?? 503 }));
}
