// Launcher used by .mcp.json: registers tsx so the TypeScript sources run directly, from any cwd.
import { register } from 'tsx/esm/api';

register();
process.argv.push('--mcp');
await import('../src/server/main.ts');
