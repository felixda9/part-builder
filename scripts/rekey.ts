// Put raw views back on the project's key color with BiRefNet (local GPU), then normalize again:
//   npx tsx scripts/rekey.ts <project> <view...>      e.g. fox_b right back
import { loadEnv } from '../src/server/env';
import { Refs } from '../src/server/refs';
import { Session } from '../src/server/session';
import type { RefView } from '../src/core/protocol';

loadEnv();
process.env.PART_BUILDER_NO_REMEMBER = '1';
const [project, ...views] = process.argv.slice(2);
const s = new Session();
s.open(project, {});
const refs = new Refs(s);
for (const v of views) console.log('re-keyed', await refs.rekeyView((v === 'side' ? 'right' : v) as RefView));
process.exit(0);
