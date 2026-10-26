// Export shared by the MCP `export` tool and the editor's Export button.

import fs from 'node:fs';
import type { Vec3 } from '../core/math';
import { toLuau } from '../core/export/luau';
import { toRbxmx } from '../core/export/rbxmx';
import { lintScene } from '../core/lints';
import type { Session } from './session';

export interface ExportOptions {
  format?: 'rbxmx' | 'luau' | 'both';
  rig?: boolean;
  name?: string;
  offset?: Vec3;
}

export interface ExportResult {
  files: string[];
  summary: string;
  luau: string;
}

export function exportModel(session: Session, o: ExportOptions = {}): ExportResult {
  const fmt = o.format ?? 'both';
  const opts = { rig: o.rig ?? true, offset: o.offset, name: o.name ?? session.meta.name };
  const lines: string[] = [];
  const files: string[] = [];
  let luau = '';
  if (fmt !== 'luau') {
    const { xml, plan } = toRbxmx(session.scene, opts);
    const f = session.path('exports', `${opts.name}.rbxmx`);
    fs.writeFileSync(f, xml);
    files.push(f);
    lines.push(`rbxmx: ${f}`, `  ${plan.parts.length} parts (incl. root), ${plan.motors.length} Motor6D, ${plan.welds.length} welds, rig=${plan.rigged}`);
  }
  {
    const { code } = toLuau(session.scene, opts);
    luau = code;
    if (fmt !== 'rbxmx') {
      const f = session.path('exports', `${opts.name}.luau`);
      fs.writeFileSync(f, code);
      files.push(f);
      lines.push(`luau: ${f} (${code.length} chars)`);
    }
  }
  const lints = session.lints();
  if (lints.length) lines.push(`lints:\n${lints.map((l) => `  - ${l.kind}: ${l.message}`).join('\n')}`);
  if (session.meta.stage === 'new') {
    session.meta.stage = 'building';
    session.saveMeta();
  }
  return { files, summary: lines.join('\n'), luau };
}
