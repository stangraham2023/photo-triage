import type { Decision, PhotoRecord } from './types.ts';

export interface Summary {
  total: number;
  good: number;
  rejected: number;
  unreadable: number;
  notDownloaded: number;
  byReason: Record<string, number>;
}

export function summarize(decisions: Decision[]): Summary {
  const s: Summary = {
    total: decisions.length, good: 0, rejected: 0, unreadable: 0, notDownloaded: 0, byReason: {},
  };
  for (const d of decisions) {
    if (d.verdict === 'good') s.good++;
    else if (d.verdict === 'rejected') s.rejected++;
    else if (d.verdict === 'not-downloaded') s.notDownloaded++;
    else s.unreadable++;
    for (const r of d.reasons) s.byReason[r.code] = (s.byReason[r.code] ?? 0) + 1;
  }
  return s;
}

function csvField(v: unknown): string {
  const str = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const CSV_HEADER = [
  'relPath', 'verdict', 'reasons', 'blurGlobal', 'blurSharpestRegion',
  'blurFaceMin', 'exposure', 'eyeMin', 'faceCount', 'phash', 'captureTime', 'camera',
];

export function toCsv(records: PhotoRecord[], decisions: Decision[]): string {
  const byId = new Map(records.map((r) => [r.file.relPath, r]));
  const rows = [CSV_HEADER.join(',')];

  for (const d of decisions) {
    const r = byId.get(d.id);
    rows.push([
      d.id,
      d.verdict,
      d.reasons.map((x) => x.detail).join('; '),
      r?.scores.blurGlobal.toFixed(1),
      r?.scores.blurSharpestRegion.toFixed(1),
      r?.scores.blurFaceMin?.toFixed(1) ?? '',
      r?.scores.exposure.toFixed(1),
      r?.scores.eyeMin?.toFixed(3) ?? '',
      r?.scores.faceCount,
      r?.scores.phash,
      r?.meta.captureTimeMs ? new Date(r.meta.captureTimeMs).toISOString() : '',
      r?.meta.cameraModel ?? '',
    ].map(csvField).join(','));
  }
  return rows.join('\n') + '\n';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function toHtml(records: PhotoRecord[], decisions: Decision[], summary: Summary): string {
  const byId = new Map(records.map((r) => [r.file.relPath, r]));
  const rows = decisions.map((d) => {
    const r = byId.get(d.id);
    return `<tr class="${d.verdict}">
      <td>${escapeHtml(d.id)}</td>
      <td>${d.verdict}</td>
      <td>${escapeHtml(d.reasons.map((x) => x.detail).join('; '))}</td>
      <td>${r?.scores.blurSharpestRegion.toFixed(1) ?? ''}</td>
      <td>${r?.scores.exposure.toFixed(1) ?? ''}</td>
    </tr>`;
  }).join('\n');

  return `<!doctype html>
<meta charset="utf-8">
<title>Photo Triage report</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #ddd; }
  tr.rejected { background: #fff5f5; }
  tr.unreadable { background: #fffbe6; }
</style>
<h1>Photo Triage report</h1>
<p>${summary.total} photos — ${summary.good} good, ${summary.rejected} rejected, ${summary.unreadable} unreadable.</p>
<table>
  <thead><tr><th>File</th><th>Verdict</th><th>Reasons</th><th>Blur</th><th>Exposure</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
`;
}
