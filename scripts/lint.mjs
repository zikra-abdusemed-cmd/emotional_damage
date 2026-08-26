import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'public', 'scripts', 'test'];
const files = [];
const forbidden = [
  { pattern: /\btts\b/i, message: 'Do not add TTS.' },
  { pattern: /voice cloning/i, message: 'Do not add voice cloning.' },
  { pattern: /youtube/i, message: 'Do not add YouTube scraping/downloading.' },
  { pattern: /setInterval\s*\(\s*reminder/i, message: 'Do not use a fixed reminder interval.' }
];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) walk(path);
    else if (/\.(mjs|js|html|css)$/.test(entry)) files.push(path);
  }
}

for (const root of roots) walk(root);

const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (/\t/.test(text)) problems.push(`${file}: tabs are not used in this project.`);
  if (file === join('scripts', 'lint.mjs')) continue;
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) problems.push(`${file}: ${rule.message}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log(`Linted ${files.length} files.`);
