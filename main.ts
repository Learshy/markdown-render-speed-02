// Driver for the markdown-render-speed-02 entry. The harness runs
// `node /bot/main.ts` on Node 22: it reads every case from the input
// directory, renders each one on its own with parse() from parse.js,
// and writes the HTML strings (in the cases' order) to html.json in
// the output directory. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand
// in for /input and /output outside a container.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
