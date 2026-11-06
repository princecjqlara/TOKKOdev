// Compile the shared TypeScript worker without starting a development server.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
if (!process.argv.includes('--apply') || !process.argv.includes('--all-pages') && !process.argv.includes('--page-id')) {
    throw Error('Use --apply and either --all-pages or --page-id <UUID>.');
}
const output=resolve('.vercel/recover-contacts-runtime.mjs');
fs.mkdirSync('.vercel',{recursive:true});
await build({entryPoints:['scripts/recover-contacts.ts'],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'error'});
await import(pathToFileURL(output).href);
