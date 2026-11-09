import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
// Block browser code from importing backend storage and AI providers
const forbiddenWebImports = /^(?:@prisma\/client|pg|@elastic\/elasticsearch|openai|@ai-sdk\/|ai$|@google\/genai)/;

// Read implementation source recursively for import-boundary checks
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

// Collect static and dynamic module imports from source text
function importsFrom(source) {
  return [...source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)].map((match) => match[2]);
}

test('browser features do not import backend storage, search, or AI providers', async () => {
  const files = await sourceFiles(path.join(root, 'web', 'src'));
  const violations = [];

  for (const file of files) {
    const imports = importsFrom(await readFile(file, 'utf8'));
    for (const specifier of imports) {
      if (forbiddenWebImports.test(specifier)) violations.push(`${path.relative(root, file)} imports ${specifier}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('backend application services do not depend on Express', async () => {
  const files = await sourceFiles(path.join(root, 'backend', 'src', 'features'));
  const violations = [];

  for (const file of files.filter((entry) => entry.includes(`${path.sep}application${path.sep}`))) {
    for (const specifier of importsFrom(await readFile(file, 'utf8'))) {
      if (specifier === 'express' || specifier.startsWith('express/')) violations.push(path.relative(root, file));
    }
  }

  assert.deepEqual(violations, []);
});

test('backend features import other feature code only through public entry points', async () => {
  const featuresRoot = path.join(root, 'backend', 'src', 'features');
  const files = await sourceFiles(featuresRoot);
  const violations = [];

  for (const file of files) {
    const relativePath = path.relative(featuresRoot, file);
    const owner = relativePath.split(path.sep)[0];
    for (const specifier of importsFrom(await readFile(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const target = path.relative(featuresRoot, path.resolve(path.dirname(file), specifier)).split(path.sep);
        if (target[0] && target[0] !== '..' && target[0] !== owner && !/^public(?:\.[cm]?[jt]s)?$/.test(target[1] ?? '')) {
          violations.push(`${path.relative(root, file)} imports ${specifier}`);
        }
        continue;
      }

      const match = specifier.match(/(?:^|\/)features\/([^/]+)(?:\/(.*))?$/);
      if (match && match[1] !== owner && match[2] !== 'public') {
        violations.push(`${path.relative(root, file)} imports ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('web features import sibling features only through public entry points', async () => {
  const featuresRoot = path.join(root, 'web', 'src', 'features');
  const files = await sourceFiles(featuresRoot);
  const violations = [];

  for (const file of files) {
    const relativePath = path.relative(featuresRoot, file);
    const owner = relativePath.split(path.sep)[0];
    for (const specifier of importsFrom(await readFile(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const targetPath = path.resolve(path.dirname(file), specifier);
      const target = path.relative(featuresRoot, targetPath).split(path.sep);
      if (target[0] && target[0] !== '..' && target[0] !== owner && !/^public(?:\.[cm]?[jt]sx?)?$/.test(target[1] ?? '')) {
        violations.push(`${path.relative(root, file)} imports ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
