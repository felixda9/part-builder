// Tiny DOM helpers: element builder, toasts, lightbox.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

/**
 * h('div', { class: 'row', onclick: fn, title: 'x' }, child, ...)
 * `on*` keys become event listeners; value/checked/disabled/selected are set as properties;
 * `style` may be a string or an object; everything else becomes an attribute.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'title') (el as unknown as Record<string, unknown>)[k] = v;
      else if (k === 'class') el.className = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

/** Append children, skipping null/false and flattening arrays. */
export function put(el: Element, ...children: (Child | Child[])[]): void {
  append(el, children);
}

function append(el: Element, children: (Child | Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

/** True when keyboard input is going into a form control. */
export function typing(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable;
}

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';

export function toast(message: string, kind: ToastKind = 'info', ms?: number): void {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = h('div', { class: `toast ${kind}`, title: 'click to dismiss' }, message);
  const kill = () => el.remove();
  el.addEventListener('click', kill);
  box.append(el);
  while (box.children.length > 6) box.firstElementChild?.remove();
  setTimeout(kill, ms ?? (kind === 'error' ? 8000 : kind === 'warn' ? 6000 : 3500));
}

export function lightbox(url: string, caption?: string): void {
  const el = h('div', { class: 'lightbox' }, h('img', { src: url, alt: caption ?? '' }), caption ? h('div', { class: 'cap' }, caption) : null);
  const close = () => { el.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  el.addEventListener('click', close);
  window.addEventListener('keydown', onKey, true);
  document.body.append(el);
}

export function fmtNum(v: number, digits = 3): string {
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return String(Object.is(r, -0) ? 0 : r);
}

export function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
