import { brl, esc } from './core.js';

export function sparkline(values, color = 'var(--accent)') {
  const w = 84, h = 26, max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - (v / max) * (h - 4)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${line}L${w},${h}L0,${h}Z" fill="${color}" opacity=".14"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

const short = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v * 10) / 10));
const dmy = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
const W = 760, H = 230, T = 14, B = 26;

/** Gráfico de linha/área em SVG. target opcional (linha tracejada). */
export function lineChart({ labels, values, color, target, format = (v) => brl(v) }) {
  const L = 46, R = 12;
  const nums = values.filter((v) => v != null);
  const max = Math.max(...nums, target ?? 0, 1) * 1.12;
  const x = (i) => L + (i / Math.max(labels.length - 1, 1)) * (W - L - R);
  const y = (v) => T + (1 - v / max) * (H - T - B);

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    grid += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 8}" y="${yy + 3}" text-anchor="end">${esc(format(v).replace('R$ ', ''))}</text>`;
  }
  const step = Math.ceil(labels.length / 7);
  const xl = labels.map((l, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(dmy(l))}</text>` : '')).join('');

  let path = '', started = false, first = 0, last = 0;
  values.forEach((v, i) => {
    if (v == null) { started = false; return; }
    path += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    if (!started) first = i;
    last = i; started = true;
  });
  const area = path ? `${path}L${x(last)},${H - B}L${x(first)},${H - B}Z` : '';
  const dots = values.map((v, i) => (v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${color}"><title>${esc(labels[i])}: ${esc(format(v))}</title></circle>`)).join('');
  const tl = target > 0 ? `<line class="target" x1="${L}" x2="${W - R}" y1="${y(target)}" y2="${y(target)}"/><text x="${W - R}" y="${y(target) - 5}" text-anchor="end" style="fill:var(--warn)">meta ${esc(format(target))}</text>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
    ${grid}${xl}${area ? `<path d="${area}" fill="${color}" opacity=".12"/>` : ''}
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>${tl}${dots}</svg>`;
}

/**
 * Gráfico multi-série com até dois eixos Y.
 * series: [{ name, color, values[], type: 'line'|'bar', axis: 0|1 }]
 * formats: [fmtEixo0, fmtEixo1]
 */
export function multiChart({ labels, series, formats = [short, short] }) {
  const dual = series.some((s) => s.axis === 1);
  const L = 46, R = dual ? 46 : 12;
  const n = labels.length;
  const maxOf = (axis) => Math.max(...series.filter((s) => (s.axis ?? 0) === axis).flatMap((s) => s.values.map((v) => v ?? 0)), 1) * 1.12;
  const max = [maxOf(0), maxOf(1)];
  const x = (i) => L + ((i + 0.5) / n) * (W - L - R);
  const y = (v, axis) => T + (1 - v / max[axis]) * (H - T - B);

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const yy = T + (1 - i / 4) * (H - T - B);
    grid += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 8}" y="${yy + 3}" text-anchor="end">${esc(formats[0]((max[0] / 4) * i).replace('R$ ', ''))}</text>`;
    if (dual) grid += `<text x="${W - R + 8}" y="${yy + 3}">${esc(formats[1]((max[1] / 4) * i))}</text>`;
  }
  const step = Math.ceil(n / 7);
  const xl = labels.map((l, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(dmy(l))}</text>` : '')).join('');

  const bars = series.filter((s) => s.type === 'bar');
  const slot = ((W - L - R) / n) * 0.72;
  const bw = Math.max(2, Math.min(28, slot / Math.max(bars.length, 1)));
  let body = '';
  bars.forEach((s, bi) => {
    const ax = s.axis ?? 0;
    s.values.forEach((v, i) => {
      if (!v) return;
      const bx = x(i) - (bars.length * bw) / 2 + bi * bw;
      body += `<rect x="${bx.toFixed(1)}" y="${y(v, ax).toFixed(1)}" width="${bw - 1}" height="${(H - B - y(v, ax)).toFixed(1)}" rx="2" fill="${s.color}" opacity=".85"><title>${esc(s.name)} · ${esc(labels[i])}: ${esc(formats[ax](v))}</title></rect>`;
    });
  });
  for (const s of series.filter((q) => q.type !== 'bar')) {
    const ax = s.axis ?? 0;
    const pts = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v ?? 0, ax).toFixed(1)}`).join('');
    body += `<path d="${pts}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    body += s.values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v ?? 0, ax)}" r="${n > 45 ? 0 : 2.6}" fill="${s.color}"><title>${esc(s.name)} · ${esc(labels[i])}: ${esc(formats[ax](v ?? 0))}</title></circle>`).join('');
  }
  const legend = `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  return `${legend}<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${grid}${xl}${body}</svg>`;
}
