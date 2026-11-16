import { applyChange } from './management.ts';
let raw = '';
try {
  for await (const chunk of process.stdin) raw += chunk;
  const { agentDir, input, guard, config } = JSON.parse(raw);
  console.log(JSON.stringify(await applyChange(agentDir, input, guard, process.cwd(), config)));
} catch (error) {
  const failure = error as Error & { status?: number };
  console.log(JSON.stringify({ error: failure.message, status: failure.status ?? 503 }));
}
