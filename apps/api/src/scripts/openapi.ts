/** Write the OpenAPI document to ../../docs/openapi.json (pnpm --filter @salon/api openapi) */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/client.js';
import { buildApp } from '../server.js';

const app = await buildApp({ logger: false });
await app.ready();
const spec = app.swagger();
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/openapi.json');
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(spec, null, 2) + '\n');
const paths = Object.keys((spec as { paths?: object }).paths ?? {}).length;
console.log(`wrote ${out} (${paths} paths)`);
await app.close();
await db.destroy();
