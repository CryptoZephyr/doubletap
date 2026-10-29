import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const root = import.meta.dirname;

for (const name of ['pay-naive', 'pay-doubletap']) {
  const outfile = resolve(root, 'dist', name, 'index.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(root, 'functions', `${name}.mjs`)],
    outfile,
    bundle: true,
    packages: 'bundle',
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
}
