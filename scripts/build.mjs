import {build} from 'esbuild';

await build({
  entryPoints: ['src/plugin.js'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2021',
  external: ['obsidian', '@codemirror/view'],
  outfile: 'main.js',
  minify: true,
  legalComments: 'none'
});
