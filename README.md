# 崇拜幻灯片格式统一工具 · church-slide-fixer

一个**纯浏览器端**的小工具：检查并统一 ProPresenter 7 演示文稿（`.proPlaylist`）里的字体，
修复「Windows 制作、Mac 播放」时常见的字体不一致问题。文件**不会上传任何服务器**。

## 解决什么问题

每周不同的人在 Windows 上用 ProPresenter 制作主日崇拜幻灯片，播放时用的是 Mac。常见问题：

- **字体在 Mac 上缺失** —— Windows 上用的品牌字体（如锐黑体 Tensentype RuiHeiJ）Mac 没装，
  ProPresenter 会自动替换成别的字体，导致上屏效果和制作时不一样。
- **字体元数据不一致** —— 同一个字体，家族名字段有时存显示名（`Tensentype RuiHeiJ`），
  有时存 PostScript 名（`Tensentype-RuiHeiJ-W4`），这种跨平台差异会让字体匹配出问题。

本工具会：

1. **统一字体** —— 把主内容文字统一映射到一个 Mac 系统自带的字体（默认 **PingFang SC 苹方**），
   计时器、字幕等非歌词元素保持不动。
2. **修复字体元数据** —— 消除 Windows/Mac 之间家族名不一致。
3. **（可选）统一字号** —— 默认**不改字号**；如需要可选择按同框 / 每篇 / 全局统一。

## 给同工的使用说明（不需要懂技术）

网址：**<https://lexchenzhang.github.io/pro-presenter-polisher/>**（建议存成书签）

1. 用电脑浏览器打开上面的网址。
2. 把这周的 `.proPlaylist` 文件**拖进网页中间的方框**（或点方框选择文件）。
3. 稍等一两秒，网页会显示这个文件的检查报告：用了什么字体、有多少处不一致。
4. 一般**不用改任何选项**，直接点蓝色的 **「应用并生成文件」** 按钮。
5. 点 **「下载修复后的文件」**，会得到一个名字带「(统一字体)」的新文件。
6. 在 **Mac 的 ProPresenter** 里打开这个新文件，确认字体、排版显示正常。
7. 确认没问题后，用新文件替换原来的即可。

小贴士：

- **原始文件不会被改动**，工具生成的是一个新文件，改坏了也不影响原件，可以放心试。
- 文件**只在你自己的浏览器里处理，不会上传到网上**，教会资料是安全的。
- 想换成别的字体、或顺便统一字号？在「修复选项」里调一下再点应用就行。

## 使用方法（简版）

打开网页 → 拖入 `.proPlaylist` → 查看报告 → （可选）调整选项 → 「应用并生成文件」→ 下载 →
在 ProPresenter 里确认。**原始文件不会被改动。**

## 隐私

全部处理都在你的浏览器本地完成，教会的崇拜文件**不会离开你的电脑**，不上传、不缓存到任何服务器。

## 它是怎么工作的

`.proPlaylist` 是一个 ZIP，里面的 `.pro` 文档是 **Protocol Buffers 二进制**（没有公开的 schema）。
本工具用一个**无需 schema 的编解码器**：只改动认识的字段（字体名、家族名、字号，以及同步的 RTF 副本），
其余字节原样保留 —— 因此不会丢失任何未知数据，也不会破坏文件结构。这一无损特性有测试逐字节验证。

## 本地开发

```bash
npm install
npm run dev      # 本地开发服务器
npm run build    # 生产构建，输出到 dist/
npm test         # 运行测试
```

> 集成测试会读取 `.local-fixtures/` 下的真实 `.proPlaylist`（该目录已被 gitignore，**不会入库**）。
> 没有该文件时，相关集成测试会自动跳过。**请勿把真实崇拜文件提交到公开仓库。**

## 部署到 GitHub Pages

仓库已包含 `.github/workflows/deploy.yml`：推送到 `main` 分支后，GitHub Actions 会自动构建并发布到 Pages。

一次性设置：仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
构建时 `BASE_PATH` 会自动取仓库名，站点地址为 `https://<用户名>.github.io/<仓库名>/`。

## 技术栈

Vite · React · TypeScript · Tailwind CSS · JSZip · Vitest。核心逻辑（`src/lib/`）与框架无关、可单测。
