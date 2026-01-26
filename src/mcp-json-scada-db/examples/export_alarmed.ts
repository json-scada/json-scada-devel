import fs from 'fs';
import path from 'path';
import { ConnectionManager } from "../src/jsonscada/connection-manager.js";

const OUT_CSV = path.join(new URL('.', import.meta.url).pathname, 'alarmed_points.csv').replace(/^[A-Za-z]:/, (m) => m);
const OUT_SUMMARY = path.join(new URL('.', import.meta.url).pathname, 'alarmed_summary.json').replace(/^[A-Za-z]:/, (m) => m);

const mgr = new ConnectionManager({ manageRedundancy: false });

mgr.run(async (client, db) => {
  try {
    const cursor = mgr
      .getRealtimeDataCollection()
      .find({ alarmed: true })
      .project({ _id: 1, tag: 1, group1: 1, group2: 1, timeTagAlarm: 1, alarmState: 1 });

    const out = fs.createWriteStream('examples/alarmed_points.csv', { flags: 'w' });
    const header = ['_id', 'tag', 'group1', 'group2', 'timeTagAlarm', 'alarmState'];
    out.write(header.join(',') + '\n');

    const group1Counts: Record<string, number> = {};
    const group12Counts: Record<string, number> = {};

    let total = 0;

    for await (const doc of cursor) {
      total++;
      const row = [
        doc._id,
        csvEscape(doc.tag),
        csvEscape(doc.group1 || ''),
        csvEscape(doc.group2 || ''),
        csvEscape(doc.timeTagAlarm || ''),
        doc.alarmState ?? ''
      ];
      out.write(row.join(',') + '\n');

      const g1 = doc.group1 || '(undefined)';
      const g2 = doc.group2 || '(undefined)';
      group1Counts[g1] = (group1Counts[g1] || 0) + 1;
      const key12 = `${g1}||${g2}`;
      group12Counts[key12] = (group12Counts[key12] || 0) + 1;
    }

    out.end();

    const summary = {
      totalAlarmed: total,
      byGroup1: group1Counts,
      byGroup1Group2: Object.fromEntries(Object.entries(group12Counts).map(([k, v]) => [k.replace('||', ' >>> '), v])),
    };

    fs.writeFileSync('examples/alarmed_summary.json', JSON.stringify(summary, null, 2));

    console.log(`Exported ${total} alarmed points to examples/alarmed_points.csv`);
    console.log('Summary written to examples/alarmed_summary.json');
    console.log('Top 10 groups by group1:');
    printTop(group1Counts, 10);

    process.exit(0);
  } catch (err) {
    console.error('Error exporting alarmed points:', err);
    process.exit(1);
  }
});

function csvEscape(v: any) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function printTop(obj: Record<string, number>, n = 10) {
  const arr = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  for (const [k, v] of arr) console.log(`${v}	${k}`);
}
