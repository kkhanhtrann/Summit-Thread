import { spawn } from 'node:child_process';

// Run both app watchers in the terminal while keeping their output visible
const children = [
  ['backend', ['--prefix', 'backend', 'run', 'dev']],
  ['web', ['--prefix', 'web', 'run', 'dev']]
].map(([name, args]) => {
  const child = spawn('npm', args, { stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code && !stopping) void stop(code);
  });
  return { name, child };
});

let stopping = false;

// Stop every child only once so repeated signals cannot race shutdown
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  const running = children.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  for (const { child } of running) child.kill('SIGTERM');
  await Promise.all(running.map(({ child }) => new Promise((resolve) => child.once('exit', resolve))));
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
