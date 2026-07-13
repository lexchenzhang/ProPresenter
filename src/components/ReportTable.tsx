import { useState } from 'react'
import type { BoxRow, FixEdit, PlaylistReport } from '../lib/analyzer'

interface FileGroup {
  file: string
  rows: BoxRow[]
  fonts: string[]
  sizes: number[]
  metaCount: number
  changeCount: number
}

function groupByFile(report: PlaylistReport, edits: FixEdit[]): FileGroup[] {
  const changeByFile = new Map<string, number>()
  for (const e of edits) changeByFile.set(e.file, (changeByFile.get(e.file) ?? 0) + 1)

  const byFile = new Map<string, BoxRow[]>()
  for (const r of report.rows) {
    if (!byFile.has(r.file)) byFile.set(r.file, [])
    byFile.get(r.file)!.push(r)
  }
  return [...byFile.entries()].map(([file, rows]) => {
    const content = rows.filter((r) => r.role === 'content')
    return {
      file,
      rows,
      fonts: [...new Set(content.map((r) => r.ps).filter(Boolean))],
      sizes: [...new Set(content.map((r) => r.size).filter((s): s is number => s != null))].sort(
        (a, b) => a - b,
      ),
      metaCount: content.filter((r) => r.issues.includes('family-meta')).length,
      changeCount: changeByFile.get(file) ?? 0,
    }
  })
}

export default function ReportTable({
  report,
  edits,
}: {
  report: PlaylistReport
  edits: FixEdit[]
}) {
  const groups = groupByFile(report, edits)
  const editByKey = new Map(edits.map((e) => [`${e.file}#${e.index}`, e]))
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        <div>演示文稿</div>
        <div className="text-right">字号</div>
        <div className="text-right">元数据</div>
        <div className="text-right">将修改</div>
      </div>
      <div className="divide-y divide-slate-100">
        {groups.map((g) => {
          const isOpen = open === g.file
          return (
            <div key={g.file}>
              <button
                onClick={() => setOpen(isOpen ? null : g.file)}
                className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-slate-50"
              >
                <div className="min-w-0">
                  <span className="mr-1 text-slate-400">{isOpen ? '▾' : '▸'}</span>
                  <span className="font-medium text-slate-700">{g.file.replace(/\.pro$/, '')}</span>
                  <span className="ml-2 text-xs text-slate-400">{g.fonts.join(', ') || '—'}</span>
                </div>
                <div className="text-right text-xs text-slate-500">
                  {g.sizes.length ? g.sizes.join('/') : '—'}
                </div>
                <div className="text-right">
                  {g.metaCount > 0 ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
                      {g.metaCount}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-300">0</span>
                  )}
                </div>
                <div className="text-right">
                  {g.changeCount > 0 ? (
                    <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-xs font-medium text-indigo-700">
                      {g.changeCount}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-300">0</span>
                  )}
                </div>
              </button>
              {isOpen && (
                <div className="bg-slate-50/60 px-4 py-2">
                  <table className="w-full text-xs">
                    <thead className="text-slate-400">
                      <tr className="text-left">
                        <th className="py-1 font-normal">文本框</th>
                        <th className="py-1 font-normal">类型</th>
                        <th className="py-1 font-normal">字体</th>
                        <th className="py-1 font-normal">字号</th>
                        <th className="py-1 font-normal">变更</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-600">
                      {g.rows.map((r) => {
                        const edit = editByKey.get(`${r.file}#${r.index}`)
                        return (
                          <tr key={r.index} className="border-t border-slate-100">
                            <td className="py-1 pr-2">{r.name || <em className="text-slate-300">（无名）</em>}</td>
                            <td className="py-1 pr-2">
                              {r.role === 'content' ? (
                                <span className="text-slate-500">内容</span>
                              ) : (
                                <span className="text-slate-300">标签</span>
                              )}
                            </td>
                            <td className="py-1 pr-2">
                              <span className={r.issues.includes('family-meta') ? 'text-amber-700' : ''}>
                                {r.ps || '—'}
                              </span>
                            </td>
                            <td className="py-1 pr-2">{r.size ?? '—'}</td>
                            <td className="py-1">
                              {edit ? (
                                <span className="text-indigo-600">
                                  {edit.scripture && (
                                    <span className="mr-1 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium text-emerald-700">
                                      经文排版
                                    </span>
                                  )}
                                  → {edit.after.ps}
                                  {edit.after.size !== edit.before.size && ` · ${edit.after.size}pt`}
                                </span>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
