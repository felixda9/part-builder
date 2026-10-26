import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROJECTS_DIR = path.join(ROOT, 'projects');
export const STYLES_DIR = path.join(ROOT, 'styles');
export const TEMPLATES_DIR = path.join(ROOT, 'templates');
export const WEB_DIST = path.join(ROOT, 'dist', 'web');
export const RUNTIME_DIR = path.join(ROOT, '.runtime');

/** Logs go to stderr: stdout is reserved for MCP traffic. */
export const log = (...args: unknown[]) => console.error('[part-builder]', ...args);
