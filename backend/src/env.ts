import * as fs from 'fs';
import * as path from 'path';

/** Minimal .env loader (no dotenv dependency). Existing process.env wins. */
export function loadEnv(): void {
  const file = path.join(__dirname, '..', '..', '.env');
  const alt = path.join(process.cwd(), '.env');
  const target = fs.existsSync(alt) ? alt : file;
  if (!fs.existsSync(target)) return;
  for (const line of fs.readFileSync(target, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
