/** Prints which token logos the share cards will use.  npx tsx scripts/logo-check.ts */
import { tokenLogo } from '../src/logos.js';
for (const a of ['0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34', '0xDfF68E53a0A8275212927c12017f5aB5f1842a04'] as const) {
  const u = await tokenLogo(a);
  console.log(a.slice(0, 8), u ? `${u.slice(0, 30)}... (${u.length} chars)` : 'NONE');
}
process.exit(0);
