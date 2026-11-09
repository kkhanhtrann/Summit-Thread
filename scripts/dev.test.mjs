import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('development launcher preserves a failing watcher exit status', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'summit-dev-'));
  const npm = path.join(directory, 'npm');
  writeFileSync(npm, `#!${process.execPath}
if (process.argv.includes('backend')) setTimeout(() => process.exit(7), 100); else setInterval(() => {}, 1000);
`);
  chmodSync(npm, 0o700);
  try {
    const result = spawnSync(process.execPath, ['scripts/dev.mjs'], { env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH }, timeout: 5000 });
    assert.equal(result.status, 7, result.stderr?.toString());
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
