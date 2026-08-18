#!/usr/bin/env node
/**
 * Progress + sanity check. `npm run verify`
 * Lists which modules are still stubs and runs a production build.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js') || name.endsWith('.css')) out.push(p);
  }
  return out;
}

const files = walk(join(root, 'src'));
const stubs = files.filter((f) => /—\s*STUB|WS-[A-H] owns this file/.test(readFileSync(f, 'utf8')));

console.log(`\nmodules: ${files.length}   still stubbed: ${stubs.length}`);
for (const s of stubs) console.log('  · ' + s.replace(root, ''));

console.log('\nbuilding…');
try {
  execSync('npm run build', { cwd: root, stdio: 'pipe' });
  console.log('build OK\n');
} catch (err) {
  console.error('BUILD FAILED\n' + (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? ''));
  process.exit(1);
}
