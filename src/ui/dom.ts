/** Mini utilidades DOM sin framework. */
export type Child = Node | string | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function svg(path: string, size = 22): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.innerHTML = path;
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Markdown ligero → HTML seguro (para respuestas IA y comentarios). */
export function miniMarkdown(md: string): string {
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    let line = escapeHtml(raw);
    line = line.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${m[1]}</li>`;
      continue;
    }
    if (inList) {
      html += '</ul>';
      inList = false;
    }
    const hm = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hm) html += `<h${hm[1].length + 2}>${hm[2]}</h${hm[1].length + 2}>`;
    else if (line.trim() === '') html += '';
    else html += `<p>${line}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches;
}

export function isIOS(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}
