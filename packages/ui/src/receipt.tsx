import { useEffect, useMemo, useState } from 'react';
import { Button } from './components.js';
import { cx, formatInr } from './format.js';

export interface ReceiptData {
  /** e.g. "payment receipt" */
  kind: string;
  rows: [label: string, value: string][];
  amountMinor: string;
  /** extra rows below the amount (ledger txn, debits, credits, drift) */
  ledger?: [label: string, value: string][];
  /** the closing word, e.g. SETTLED */
  status: string;
  /** seed for the barcode so the same payment always prints the same bars */
  barcodeSeed: string;
  /** file name base for the download */
  fileName: string;
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

function receiptText(d: ReceiptData, brand: string): string {
  const pad = (a: string, b: string) => a.padEnd(14) + b;
  return [brand.toUpperCase(), d.kind, '--------------------------', ...d.rows.map(([a, b]) => pad(a, b)), '--------------------------', formatInr(d.amountMinor), '--------------------------', ...(d.ledger ?? []).map(([a, b]) => pad(a, b)), '--------------------------', d.status, ''].join('\n');
}

/**
 * A thermal receipt. The paper "prints" downward in steps (CSS steps() clip, like a thermal head), has a torn edge,
 * and can be printed (only the paper is printed) or downloaded as plain text.
 */
export function Receipt({ data, brand, className }: { data: ReceiptData; brand: string; className?: string }) {
  const [printed, setPrinted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setPrinted(true), 120);
    return () => clearTimeout(t);
  }, []);
  const bars = useMemo(() => {
    let h = hash(data.barcodeSeed);
    return Array.from({ length: 46 }, () => {
      h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
      return 1 + (h % 3);
    });
  }, [data.barcodeSeed]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([receiptText(data, brand)], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.fileName}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={className}>
      <div aria-hidden="true" className="relative h-[38px] rounded-t-xl rounded-b-sm bg-[#1c1c1c] shadow-[inset_0_-2px_0_#000] after:absolute after:inset-x-[18px] after:bottom-2 after:h-1 after:rounded-sm after:bg-black" />
      <div className="zd-printable relative mx-[22px]">
        <div
          className="zd-paper relative bg-[#fcfbf7] font-[family-name:var(--font-mono)] text-xs leading-[1.6] text-[#2a2a2a] shadow-[0_10px_20px_-12px_rgba(0,0,0,0.4)]"
          style={{ clipPath: printed ? 'inset(0 0 0 0)' : 'inset(0 0 100% 0)', transition: 'clip-path 2.4s steps(16, end)' }}
        >
          <div className="px-[18px] pb-7 pt-[18px]">
            <div className="text-center"><b>{brand.toUpperCase()}</b><br />{data.kind}</div>
            <hr className="my-2.5 border-0 border-t border-dashed border-[#9a9a95]" />
            {data.rows.map(([a, b]) => (
              <div key={a} className="flex justify-between gap-2"><span>{a}</span><span className="text-right">{b}</span></div>
            ))}
            <hr className="my-2.5 border-0 border-t border-dashed border-[#9a9a95]" />
            <div className="my-1.5 text-center text-[22px] font-semibold">{formatInr(data.amountMinor)}</div>
            <hr className="my-2.5 border-0 border-t border-dashed border-[#9a9a95]" />
            {(data.ledger ?? []).map(([a, b]) => (
              <div key={a} className="flex justify-between gap-2"><span>{a}</span><span className="text-right">{b}</span></div>
            ))}
            <hr className="my-2.5 border-0 border-t border-dashed border-[#9a9a95]" />
            <div className="text-center">{data.status}</div>
            <div aria-hidden="true" className="mt-3 flex h-[42px] gap-0.5">
              {bars.map((w, i) => (
                <span key={i} className="bg-[#222]" style={{ width: w }} />
              ))}
            </div>
          </div>
          <div aria-hidden="true" className="zd-paper-edge" />
        </div>
      </div>
      <div className={cx('mt-4 flex gap-2')}>
        <Button size="sm" onClick={() => window.print()}>
          Print
        </Button>
        <Button size="sm" onClick={download}>
          Download .txt
        </Button>
      </div>
    </div>
  );
}
