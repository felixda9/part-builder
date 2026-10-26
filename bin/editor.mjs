// `npm run editor`: the editor server without MCP, for manual modelling.
import { register } from 'tsx/esm/api';

register();
await import('../src/server/main.ts');
