// Copies ABIs from the Foundry build (contracts/out) into src/abi so the solver uses exactly what is deployed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'contracts', 'out');
const dest = join(here, '..', 'src', 'abi');
mkdirSync(dest, { recursive: true });
const contracts = [
  ['QalibreSettlement.sol', 'QalibreSettlement'],
  ['QalibreAccount.sol', 'QalibreAccount'],
  ['QalibreAccountFactory.sol', 'QalibreAccountFactory'],
  ['QwapV2Adapter.sol', 'QwapV2Adapter'],
];
for (const [file, name] of contracts) {
  const { abi } = JSON.parse(readFileSync(join(out, file, `${name}.json`), 'utf8'));
  writeFileSync(join(dest, `${name}.ts`), `export const ${name}Abi = ${JSON.stringify(abi, null, 2)} as const;\n`);
  console.log(`exported ${name} (${abi.length} entries)`);
}
