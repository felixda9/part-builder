// MCP tool registrations. Claude Code talks to these over stdio.

import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type Command, CommandError, zCommand } from '../core/commands';
import type { Vec3 } from '../core/math';
import type { ViewName } from '../core/raster';
import { exportModel } from './exporter';
import { comfyConfig } from './comfy';
import { hasApiKey } from './gemini';
import { defaultProvider, fakeMode, totalCost } from './imagegen';
import { registerRefsTools } from './mcp-refs';
import { describeScene, sceneBounds } from '../core/summary';
import { lintScene } from '../core/lints';
import { ALL_VIEWS, renderSheet } from './render';
import { Session } from './session';
import { similarityText } from './similarity';
import { defaultBones } from './body';

export const INSTRUCTIONS = `Builds Roblox models out of native parts (Block, Wedge, CornerWedge) with solid colors.
Conventions: 1 unit = 1 stud, Y up. The model faces -Z (its front) and its right side is +X. Stand it on y=0, centred on x=0.
View names say which side of the model is visible: front (camera at -Z, the model's right hand appears on image-left), back, right (+X side, model faces image-right), left, top (model front at image bottom), threequarter (front-right perspective).
Default look: smooth Plastic, no studs - add surfaces 'Studs' only when the user asks for studs; parts whose largest side is under 1 stud become SmoothPlastic.
Groups are rig bones: a Motor6D drives each group's main part around the group's pivot (shoulder, hip, neck...). Build the right side, then mirror_group it for the left.
The live editor shows every change. Follow the project skill "roblox-part-model" for the full reference-image -> model procedure.`;

const text = (t: string) => ({ type: 'text' as const, text: t });
const image = (buf: Buffer, mimeType = 'image/jpeg') => ({ type: 'image' as const, data: buf.toString('base64'), mimeType });
const fail = (msg: string) => ({ content: [text(`ERROR: ${msg}`)], isError: true });

const zView = z.enum(['front', 'back', 'right', 'left', 'top', 'bottom', 'threequarter']);

function lintText(lints: ReturnType<typeof lintScene>): string {
  return lints.length ? `lints:\n${lints.map((l) => `  - ${l.kind}: ${l.message}`).join('\n')}` : 'lints: none';
}

export function createMcpServer(session: Session, ctx: { editorUrl: () => string }): McpServer {
  const server = new McpServer({ name: 'part-builder', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('project_open', {
    title: 'Open or create a project',
    description: 'Open a project by name (created if missing). Everything (refs, model, history, exports) lives in projects/<name>/. Returns status and the editor URL.',
    inputSchema: {
      name: z.string().describe('project name, e.g. "knight"'),
      idea: z.string().optional().describe('what to build, in words'),
      style: z.string().optional().describe('style preset name (styles/<name>)'),
      heightStuds: z.number().positive().optional().describe('target model height in studs (R6-sized character = 5)'),
      symmetric: z.boolean().optional().describe('left/right symmetric subject (default true)'),
      body: z.enum(['humanoid', 'quadruped', 'biped', 'bird', 'serpent', 'fish', 'object', 'other']).optional()
        .describe('what kind of body the subject has - decides the pose in every image prompt and the default bones (quadruped = four-legged animal, biped = two-legged animal like a T-rex). Guessed from the idea if not given.'),
      similarity: z.enum(['close', 'balanced', 'distinct', 'free']).optional()
        .describe('how close the build stays to the references: close = as similar as possible; balanced (default) = a few deliberate differences; distinct = its own take with more differences; free = only the overall theme. The user can also change it in the editor.'),
    },
  }, async (a) => {
    const { created } = session.open(a.name, a);
    const m = session.meta;
    const b = sceneBounds(session.scene);
    const r = session.refs;
    const cost = totalCost(session.path('gemini-log.jsonl'));
    const fb = r.feedback.slice(-5);
    return {
      content: [text([
        `${created ? 'created' : 'opened'} project "${m.name}" (${session.dir})`,
        `idea: ${m.idea || '-'} | style: ${m.style} | height: ${m.heightStuds} studs | symmetric: ${m.symmetric} | stage: ${m.stage}`,
        `similarity to the references: ${similarityText(session.similarity)}`,
        `body: ${session.body}${m.body ? '' : ' (guessed from the idea - pass body to change)'}; default bones: ${defaultBones(session.body)}`,
        `checkpoints: hero=${m.checkpoints.hero ?? 'not picked'}, views approved=${m.checkpoints.viewsApproved}`,
        `refs: ${r.hero.candidates.length} hero candidate(s), views ${Object.keys(r.views).join('/') || 'none'}${Object.values(r.views).some((v) => v?.frame) ? ' (normalized)' : ''}, close-ups: ${Object.keys(r.parts).join(', ') || 'none'}`,
        `model: ${session.scene.parts.length} parts at rev ${session.history.rev}${b ? `, size ${b.size.join(' x ')}` : ''}; ${session.iterations.length} evaluation round(s)${session.iterations.length ? `, last score ${session.iterations[session.iterations.length - 1].score}` : ''}`,
        `image source: ${fakeMode() ? 'FAKE images (offline test mode)' : defaultProvider() ?? 'NONE - set COMFYUI_URL (local GPU) or GEMINI_API_KEY in .env'}` +
          ` (comfyui ${comfyConfig() ? comfyConfig()!.url : 'not set'}, gemini ${hasApiKey() ? 'key set' : 'no key'}); ${cost.calls} image call(s), ${cost.local} local, $${cost.usd.toFixed(3)} spent`,
        `editor: ${ctx.editorUrl()}`,
        `other projects: ${Session.list().filter((p) => p !== m.name).join(', ') || '-'}`,
        ...(fb.length ? [`User notes: ${fb.map((f) => `${f.view ? `[${f.view}] ` : ''}${f.text}`).join(' | ')}`] : []),
      ].join('\n'))],
    };
  });

  server.registerTool('scene_get', {
    title: 'Read the model',
    description: 'Compact table of the model: groups (pivot, main part, mirror links) and one line per part with size, position, orientation, color, material, surfaces and its world bounding box. Optionally limited to one group, or the revision history.',
    inputSchema: {
      group: z.string().optional(),
      history: z.boolean().optional().describe('list revisions instead'),
    },
  }, async (a) => {
    if (a.history) {
      return { content: [text(session.history.list().slice(-60).map((r) => `${r.current ? '*' : ' '} rev ${r.rev}  ${r.parts} parts  ${r.label}`).join('\n'))] };
    }
    return { content: [text(describeScene(session.scene, a.group))] };
  });

  server.registerTool('scene_apply', {
    title: 'Edit the model',
    description: `Apply a batch of edit commands atomically (all or nothing), or undo/redo/checkout. Returns what changed plus lints (floating parts, separate clusters, z-fighting coplanar faces, hidden parts).
Placement commands (prefer these; they need no rotation math):
  box {name, min, max}: Block filling the box.
  wedge {name, min, max, tall, flat?}: tall = side of the box that is the full rectangle (the high end); flat = face it rests on (default '-y'). The slope faces away from both.
  cornerwedge {name, min, max, apex, flat?}: apex = corner holding the peak, e.g. '+x+y-z'.
  attach {name, to, face, size, offset?, sink?}: Block flush on a face of another part (eyes, buttons, belts); joins that part's group.
Other: part (raw CFrame), update {part, set:{...}} (set.box refits to a world box), delete, duplicate, move, rotate {axis, degrees, pivot?}, paint {parts, color?, material?, surfaces?}, group {name, parent?, pivot?, main?, parts?}, delete_group, mirror_group {source, name} (whole limb), mirror {parts} (linked twin of single side parts: rivets, pads; follows its source), unlink, mirror_copy (unlinked copy), palette {colors}.
Selectors: part name, "group:<Name>" (all parts in a group) or "*". Colors: '#rrggbb' or palette refs 'p0', 'p1'...
Every common field: color, material (Plastic|SmoothPlastic|Neon), surfaces ('Studs'|'Inlet'|'Smooth' or per face {top,bottom,front,back,left,right}), transparency, group.`,
    inputSchema: {
      ops: z.union([z.array(zCommand), z.string()]).optional().describe('commands to apply in order'),
      label: z.string().optional().describe('short label for this revision'),
      undo: z.boolean().optional(),
      redo: z.boolean().optional(),
      checkout: z.number().int().optional().describe('jump to a revision number'),
      preview: z.boolean().optional().describe('also return a front/right/threequarter render'),
    },
  }, async (a) => {
    try {
      let summary: string;
      if (a.undo || a.redo || a.checkout !== undefined) {
        const ok = a.undo ? session.undo() : a.redo ? session.redo() : session.checkout(a.checkout!);
        summary = ok ? `now at rev ${session.history.rev} (${session.history.revisions[session.history.index].label})` : 'nothing to do';
        summary += '\n' + lintText(session.lints());
      } else {
        const ops = (typeof a.ops === 'string' ? JSON.parse(a.ops) : a.ops) as Command[] | undefined;
        if (!ops?.length) return fail('pass ops (a list of commands) or undo/redo/checkout');
        const r = session.apply(ops, a.label);
        const list = (xs: string[]) => (xs.length ? (xs.length > 25 ? `${xs.slice(0, 25).join(', ')} (+${xs.length - 25})` : xs.join(', ')) : '-');
        summary = [
          `rev ${r.rev}: created ${list(r.created)} | updated ${list(r.updated)} | deleted ${list(r.deleted)}`,
          lintText(r.lints),
        ].join('\n');
      }
      const b = sceneBounds(session.scene);
      summary += `\nmodel: ${session.scene.parts.length} parts${b ? `, bounds min(${b.min.join(',')}) max(${b.max.join(',')})` : ''}`;
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [text(summary)];
      if (a.preview && session.scene.parts.length) {
        const { image: img } = await renderSheet(session.scene, { views: ['front', 'right', 'threequarter'], mode: 'color', grid: true, size: 300 });
        content.push(image(img));
      }
      return { content };
    } catch (e) {
      return fail(e instanceof CommandError || e instanceof SyntaxError ? e.message : String((e as Error).stack ?? e));
    }
  });

  server.registerTool('render', {
    title: 'Render the model',
    description: 'Render views of the model (or one group) into one labelled image. Orthographic views carry a stud grid labelled in world coordinates. Modes: color (flat-lit part colors with outlines), parts (each part a distinct color with its name written on it), silhouette.',
    inputSchema: {
      views: z.array(zView).optional().describe('default: front, right, top, threequarter'),
      mode: z.enum(['color', 'parts', 'silhouette']).optional(),
      group: z.string().optional().describe('render only this group (and its child groups)'),
      grid: z.boolean().optional().describe('stud grid on orthographic views (default true)'),
      size: z.number().int().min(128).max(900).optional().describe('tile size in pixels (default 380)'),
    },
  }, async (a) => {
    if (!session.scene.parts.length) return fail('the model is empty');
    try {
      const views = (a.views ?? ['front', 'right', 'top', 'threequarter']) as ViewName[];
      const { image: img } = await renderSheet(session.scene, { views, mode: a.mode ?? 'color', group: a.group, grid: a.grid ?? true, size: a.size ?? 380 });
      const file = session.path('renders', `rev${session.history.rev}_${a.mode ?? 'color'}_${views.join('-')}${a.group ? '_' + a.group : ''}.jpg`);
      fs.writeFileSync(file, img);
      return { content: [image(img), text(`saved ${file}`)] };
    } catch (e) {
      return fail((e as Error).message);
    }
  });

  registerRefsTools(server, session);

  server.registerTool('export', {
    title: 'Export to Roblox',
    description: 'Write the model for Roblox: .rbxmx (Studio: right-click Workspace > Insert from File) and/or a Luau builder script. With rig=true (default) every group becomes a Motor6D bone around its pivot, other parts are welded to their group\'s main part, and an anchored invisible HumanoidRootPart + AnimationController make it animatable in the Animation Editor. To push straight into an open Studio session, set include_luau and pass the returned code to the Roblox Studio MCP execute_luau tool (Edit datamodel).',
    inputSchema: {
      format: z.enum(['rbxmx', 'luau', 'both']).optional(),
      rig: z.boolean().optional(),
      name: z.string().optional().describe('model name in Roblox (default: project name)'),
      offset: z.tuple([z.number(), z.number(), z.number()]).optional().describe('move the whole model by this many studs'),
      include_luau: z.boolean().optional().describe('return the Luau code in the result'),
    },
  }, async (a) => {
    try {
      const r = exportModel(session, { format: a.format, rig: a.rig, name: a.name, offset: a.offset as Vec3 | undefined });
      const content = [text(r.summary)];
      if (a.include_luau) content.push(text(r.luau));
      return { content };
    } catch (e) {
      return fail((e as Error).message);
    }
  });

  return server;
}
