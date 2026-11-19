import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Hosted builds use production React, which omits act(). Tests must load its
// test-capable build and must never inherit application credentials.
const env={...process.env,NODE_ENV:'test'};
for(const key of Object.keys(env))if(/^(NEXTAUTH_|NEXT_PUBLIC_SUPABASE_|SUPABASE_|DATABASE_|POSTGRES_|FACEBOOK_|NVIDIA_|SYSTEM_ADMIN_|CRON_SECRET$)/.test(key))delete env[key];
const result=spawnSync(process.execPath,[fileURLToPath(new URL('../node_modules/vitest/vitest.mjs',import.meta.url)),'run',...process.argv.slice(2)],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,stdio:'inherit'});
if(result.error)throw result.error;process.exit(result.status??1);
