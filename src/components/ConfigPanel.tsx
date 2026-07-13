import { FONT_OPTIONS } from '../lib/fonts'
import type { FixConfig, PlaylistReport, PresentationInfo, SizePolicy } from '../lib/analyzer'

const SIZE_POLICIES: { value: SizePolicy; label: string; hint: string }[] = [
  { value: 'keep', label: '保持字号不变', hint: '推荐 — 只统一字体，字号原样保留' },
  { value: 'box-group', label: '统一同一文本框', hint: '同一个框在不同幻灯片间取众数，跨框不动' },
  { value: 'file-mode', label: '每篇取众数', hint: '注意：可能压平同文件里本该不同的框' },
  { value: 'global', label: '全部统一为固定字号', hint: '整个 playlist 的主文本用同一字号' },
]

// Segments the user typically fixes; used only to *highlight* and to power the
// "quick-tick" button — never to auto-select on load (the user picks manually).
const KEYWORDS = ['宣召', '读经']
function matchesKeyword(p: PresentationInfo): boolean {
  return KEYWORDS.some((k) => p.name.includes(k) || p.preview.includes(k))
}

export default function ConfigPanel({
  config,
  report,
  onChange,
}: {
  config: FixConfig
  report: PlaylistReport
  onChange: (next: FixConfig) => void
}) {
  const set = (patch: Partial<FixConfig>) => onChange({ ...config, ...patch })

  const distinctPs = [...new Set(report.contentFonts.map((f) => f.ps))]

  function toggleSource(ps: string) {
    const has = config.sourcePsNames.includes(ps)
    set({
      sourcePsNames: has
        ? config.sourcePsNames.filter((p) => p !== ps)
        : [...config.sourcePsNames, ps],
    })
  }

  // ---- presentation selection ----
  const selected = config.selectedFiles ?? []
  const selectedSet = new Set(selected)
  function toggleFile(file: string) {
    set({
      selectedFiles: selectedSet.has(file) ? selected.filter((f) => f !== file) : [...selected, file],
    })
  }
  function selectAll() {
    set({ selectedFiles: report.presentations.map((p) => p.file) })
  }
  function clearAll() {
    set({ selectedFiles: [] })
  }
  function selectKeywordMatches() {
    const add = report.presentations.filter(matchesKeyword).map((p) => p.file)
    set({ selectedFiles: [...new Set([...selected, ...add])] })
  }
  const hasKeywordMatch = report.presentations.some(matchesKeyword)

  return (
    <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-800">修复选项</h2>

      {/* 选择要处理的篇目 */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-slate-700">
            选择要处理的篇目
            <span className="ml-2 text-xs font-normal text-slate-400">
              已选 {selected.length} / {report.presentations.length}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {hasKeywordMatch && (
              <button
                onClick={selectKeywordMatches}
                className="rounded-md bg-indigo-50 px-2 py-1 font-medium text-indigo-700 hover:bg-indigo-100"
              >
                快速勾选：宣召 / 读经
              </button>
            )}
            <button onClick={selectAll} className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100">
              全选
            </button>
            <button onClick={clearAll} className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100">
              全不选
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-400">
          只有勾选的篇目会被修改，其余保持不动。「宣召」等篇名看不出来时，可看右侧文字预览确认。
        </p>
        <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {report.presentations.map((p) => {
            const isKeyword = matchesKeyword(p)
            return (
              <label
                key={p.file}
                className="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={selectedSet.has(p.file)}
                  onChange={() => toggleFile(p.file)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-slate-700">{p.name}</span>
                    {isKeyword && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        宣召/读经
                      </span>
                    )}
                    <span className="text-[10px] text-slate-400">{p.contentBoxes} 个文本框</span>
                  </span>
                  {p.preview && (
                    <span className="mt-0.5 block truncate text-xs text-slate-400">{p.preview}</span>
                  )}
                </span>
              </label>
            )
          })}
        </div>
      </section>

      {/* 字体 */}
      <section className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={config.remapFont}
            onChange={(e) => set({ remapFont: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600"
          />
          统一正文字体为
        </label>
        {config.remapFont && (
          <select
            value={config.targetFont.ps}
            onChange={(e) => {
              const f = FONT_OPTIONS.find((x) => x.ps === e.target.value)
              if (f) set({ targetFont: f })
            }}
            className="ml-6 w-full max-w-md rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.ps} value={f.ps}>
                {f.label}
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={config.fixFamilyMeta}
            onChange={(e) => set({ fixFamilyMeta: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600"
          />
          修复字体元数据（消除 Windows/Mac 家族名不一致）
        </label>
      </section>

      {/* 经文排版 */}
      <section className="space-y-1">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={config.scriptureReformat ?? false}
            onChange={(e) => set({ scriptureReformat: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600"
          />
          经文页排版修复（节号上标 + 字号自适应）
        </label>
        <p className="ml-6 text-xs text-slate-400">
          将宣召/读经的经文框重排成人工修复版的格式：节号缩小为右上角上标，正文统一字号并按文本框大小自动缩放。只影响带节号的经文框。
        </p>
      </section>

      {/* 字号 */}
      <section className="space-y-2">
        <div className="text-sm font-medium text-slate-700">字号</div>
        {SIZE_POLICIES.map((p) => (
          <label key={p.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="sizePolicy"
              checked={config.sizePolicy === p.value}
              onChange={() => set({ sizePolicy: p.value })}
              className="mt-1 h-4 w-4 border-slate-300 text-indigo-600"
            />
            <span>
              <span className="text-slate-700">{p.label}</span>
              <span className="ml-2 text-xs text-slate-400">{p.hint}</span>
            </span>
          </label>
        ))}
        {config.sizePolicy === 'global' && (
          <div className="ml-6 flex items-center gap-2 text-sm">
            <span className="text-slate-600">字号</span>
            <input
              type="number"
              min={8}
              max={800}
              value={config.globalSize}
              onChange={(e) => set({ globalSize: Number(e.target.value) })}
              className="w-24 rounded-lg border border-slate-300 px-2 py-1"
            />
            <span className="text-slate-500">pt</span>
          </div>
        )}
      </section>

      {/* 高级：处理哪些字体 */}
      {distinctPs.length > 1 && (
        <section className="space-y-2">
          <div className="text-sm font-medium text-slate-700">处理哪些内容字体</div>
          <p className="text-xs text-slate-400">
            只有这些字体的文本框会被修改（其它如计时器、字幕等保持不动）
          </p>
          <div className="flex flex-wrap gap-2">
            {distinctPs.map((ps) => (
              <label
                key={ps}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600"
              >
                <input
                  type="checkbox"
                  checked={config.sourcePsNames.includes(ps)}
                  onChange={() => toggleSource(ps)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600"
                />
                {ps}
              </label>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
