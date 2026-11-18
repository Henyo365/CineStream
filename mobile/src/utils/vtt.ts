export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

function parseTimestamp(ts: string): number {
  const clean = ts.trim().replace(',', '.');
  const parts = clean.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] ?? 0;
}

export function parseVttCues(raw: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx < 0) continue;
    const [startRaw, endRaw] = lines[timeLineIdx].split('-->');
    if (!startRaw || !endRaw) continue;
    const start = parseTimestamp(startRaw.split(' ')[0]);
    const end = parseTimestamp(endRaw.trim().split(' ')[0]);
    const text = lines
      .slice(timeLineIdx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text && end > start) {
      cues.push({ start, end, text });
    }
  }
  return cues;
}
