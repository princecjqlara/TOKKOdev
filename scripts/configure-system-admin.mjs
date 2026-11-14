import fs from 'node:fs/promises';
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import readline from 'node:readline';

const args = process.argv.slice(2);
const emailIndex = args.indexOf('--email');
const email = args[emailIndex + 1]?.trim().toLowerCase();
if (emailIndex < 0 || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || email.endsWith('@facebook.local') || args.some((arg, i) => !['--email', '--password-stdin'].includes(arg) && i !== emailIndex + 1)) {
    throw new Error('Usage: node scripts/configure-system-admin.mjs --email you@example.com [--password-stdin]');
}

async function readPassword() {
    if (args.includes('--password-stdin')) {
        let input = '';
        for await (const chunk of process.stdin) input += chunk;
        return input.replace(/\r?\n$/, '');
    }
    if (!process.stdin.isTTY) throw new Error('Use --password-stdin when no interactive terminal is available.');
    process.stdout.write('Administrator password (hidden): ');
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let password = '';
        function finish(error) {
            process.stdin.removeListener('keypress', onKey);
            process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
            if (error) reject(error); else resolve(password);
        }
        function onKey(text, key) {
            if (key?.ctrl && key.name === 'c') { finish(new Error('Cancelled.')); return; }
            if (key?.name === 'return' || key?.name === 'enter') { finish(); return; }
            if (key?.name === 'backspace') password = password.slice(0, -1);
            else if (text && !key?.ctrl && !key?.meta) password += text;
        }
        process.stdin.on('keypress', onKey);
    });
}

const password = await readPassword();
if (!password.length || Buffer.byteLength(password) > 1024) throw new Error('Enter a password of no more than 1,024 bytes.');
const salt = randomBytes(24).toString('hex');
const key = await promisify(scrypt)(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const hash = `scrypt-v1$${salt}$${key.toString('hex')}`;
let existing = '';
try { existing = await fs.readFile('.env.local', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const retained = existing.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?SYSTEM_ADMIN_(?:EMAIL|PASSWORD_HASH)\s*=/.test(line)).join('\n').trimEnd();
// Next.js expands dollar signs in .env files, including quoted values.
await fs.writeFile('.env.local', `${retained}${retained ? '\n\n' : ''}SYSTEM_ADMIN_EMAIL=${email}\nSYSTEM_ADMIN_PASSWORD_HASH=${hash.replaceAll('$', '\\$')}\n`, { mode: 0o600 });
console.log('Administrator credentials saved to ignored .env.local (password hashed). Restart the app to use them.');
console.log('Production also needs these two server environment variables and database/migration_system_admin.sql. See docs/system-admin.md.');
