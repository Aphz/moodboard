/**
 * Maquetado de texto para notas: ajuste de línea, markdown ligero
 * (**negrita**, *cursiva*, "- " viñetas, enlaces [texto](url)).
 */

export interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  link: string | null;
}

export interface TextLine {
  runs: TextRun[];
  bullet: boolean;
  width: number;
}

const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;

/** Divide un párrafo en runs con formato. */
export function parseInline(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) runs.push({ text: text.slice(last, i), bold: false, italic: false, link: null });
    const tok = m[0];
    if (tok.startsWith('**')) runs.push({ text: tok.slice(2, -2), bold: true, italic: false, link: null });
    else if (tok.startsWith('*')) runs.push({ text: tok.slice(1, -1), bold: false, italic: true, link: null });
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      runs.push({ text: mm[1], bold: false, italic: false, link: mm[2] });
    }
    last = i + tok.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), bold: false, italic: false, link: null });
  return runs;
}

export function fontString(size: number, family: string, bold: boolean, italic: boolean): string {
  return `${italic ? 'italic ' : ''}${bold ? '600 ' : '400 '}${size}px ${family}`;
}

/**
 * Ajusta el texto al ancho dado. Devuelve líneas con runs ya partidos.
 * `measure` mide un run (ctx.measureText).
 */
export function layoutText(
  text: string,
  maxWidth: number,
  size: number,
  family: string,
  measure: (s: string, font: string) => number
): TextLine[] {
  const lines: TextLine[] = [];
  for (const rawPara of text.split('\n')) {
    let para = rawPara;
    let bullet = false;
    if (/^\s*[-*•]\s+/.test(para)) {
      bullet = true;
      para = para.replace(/^\s*[-*•]\s+/, '');
    }
    const indent = bullet ? size * 1.2 : 0;
    const width = Math.max(10, maxWidth - indent);
    const runs = parseInline(para);
    let cur: TextRun[] = [];
    let curW = 0;
    const push = () => {
      lines.push({ runs: cur, bullet, width: curW + indent });
      cur = [];
      curW = 0;
    };
    if (runs.length === 0) {
      push();
      continue;
    }
    for (const run of runs) {
      const font = fontString(size, family, run.bold, run.italic);
      const words = run.text.split(/(\s+)/);
      for (const w of words) {
        if (w === '') continue;
        const ww = measure(w, font);
        if (curW + ww > width && curW > 0 && !/^\s+$/.test(w)) push();
        if (ww > width) {
          // palabra más larga que la línea: partir por caracteres
          let chunk = '';
          for (const ch of w) {
            const cw = measure(chunk + ch, font);
            if (cw > width && chunk) {
              cur.push({ ...run, text: chunk });
              curW += measure(chunk, font);
              push();
              chunk = '';
            }
            chunk += ch;
          }
          if (chunk) {
            cur.push({ ...run, text: chunk });
            curW += measure(chunk, font);
          }
          continue;
        }
        if (/^\s+$/.test(w) && curW === 0) continue;
        const lastRun = cur[cur.length - 1];
        if (lastRun && lastRun.bold === run.bold && lastRun.italic === run.italic && lastRun.link === run.link) lastRun.text += w;
        else cur.push({ ...run, text: w });
        curW += ww;
      }
    }
    push();
  }
  return lines;
}
