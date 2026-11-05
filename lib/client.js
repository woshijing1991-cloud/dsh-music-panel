// lib/client.js — 网易云音乐面板（Magpie 风格）
//
// 视觉依据：yetone/magpie（LLM 网关，Go+Wails）内置样式表里提取的设计令牌：
// 靛蓝强调色只当信号、发丝线分层、12/6px 小圆角、2px 步进刻度、
// 数字 tabular-nums、gap:1px 统计网格。
//
// 结构：main 槽放整页、sidebar.panellist 放入口图标（id 仍是 music，位置不变）。
// 数据：列表/歌词/音频全走宿主路由；收藏/历史/标签由宿主持久化到 DSH_HOME。
window.__ModuleLoader__.load({
  id: 'dsh-music-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    var PANEL_ID = 'music'
    var API = '/dsh-netease'
    var LS = 'dsh-music-panel:'

    var CHARTS = [
      { id: '3778678', name: '热歌榜' },
      { id: '3779629', name: '新歌榜' },
      { id: '19723756', name: '飙升榜' },
      { id: '2884035', name: '原创榜' },
    ]

    var PRESET_TAGS = ['华语流行', '欧美流行', '摇滚', '民谣', '电子', '说唱', '古风', '轻音乐', '爵士', '粤语', '日语', '韩语', 'R&B', '影视原声', '怀旧']

    var NAV = [
      { key: 'discover', label: '发现', icon: 'spark' },
      { key: 'search', label: '搜索', icon: 'search' },
      { key: 'charts', label: '榜单', icon: 'chart' },
      { key: 'favorites', label: '收藏', icon: 'heart' },
      { key: 'recent', label: '最近', icon: 'clock' },
      { key: 'taste', label: '口味', icon: 'sliders' },
    ]

    // ── 样式（Magpie 令牌；light-dark 跟随宿主 color-scheme） ────────────────
    var CSS = `
.np { --np-bg: light-dark(#f4f4f6, #1a1a1e);
  --np-card: light-dark(#ffffff, #232327);
  --np-card2: light-dark(#f9f9fb, #1f1f23);
  --np-pill: light-dark(#f1f1f4, #2d2d33);
  --np-pill-hover: light-dark(#e9e9ee, #36363d);
  --np-seg-thumb: light-dark(#ffffff, #35353c);
  --np-line: light-dark(#e3e3e8, #333339);
  --np-line2: light-dark(#ececf0, #2c2c32);
  --np-fg: light-dark(#1c1c21, #ededf1);
  --np-fg2: light-dark(#4b4b53, #b9b9c1);
  --np-muted: light-dark(#85858d, #8b8b94);
  --np-faint: light-dark(#b9b9c2, #56565f);
  --np-accent: light-dark(#4f46e5, #a5b4fc);
  --np-accent-soft: light-dark(#eeedfd, #2b2c47);
  --np-accent-fg: light-dark(#ffffff, #14142a);
  --np-sel: light-dark(#ecebfb, #33345a);
  --np-green: light-dark(#189a58, #6fd99b);
  --np-green-soft: light-dark(#e4f6ec, #1e3a2b);
  --np-red: light-dark(#d64545, #f28b82);
  --np-red-soft: light-dark(#fbe9e9, #45272a);
  --np-amber: light-dark(#b45309, #f2b544);
  --np-shadow: 0 16px 44px rgba(20,22,30,.16), 0 2px 8px rgba(20,22,30,.06), 0 0 0 .5px rgba(20,22,30,.10);
  --np-ease: cubic-bezier(.25,.9,.3,1);

  /* 不自己声明 color-scheme：继承宿主，否则 light-dark() 跟着 OS 而不是 DSH 主题 */
  height: 100%; min-height: 0; display: flex; flex-direction: column;
  background: var(--np-bg); color: var(--np-fg);
  font: 13px/1.4 var(--dsw-font-family, -apple-system, "Segoe UI Variable", "Segoe UI", "Inter", system-ui, sans-serif);
  -webkit-font-smoothing: antialiased;
}
.np * { box-sizing: border-box; }
.np button { font: inherit; cursor: pointer; border: 0; background: none; color: inherit; }
.np button:focus-visible, .np input:focus-visible { outline: 2px solid var(--np-accent); outline-offset: 1px; }
.np button:active:not(:disabled) { transform: scale(.96); }
.np ::-webkit-scrollbar { width: 10px; height: 10px; }
.np ::-webkit-scrollbar-thumb { background: var(--np-line); border-radius: 999px; }
.np ::-webkit-scrollbar-track { background: transparent; }

/* 顶栏 */
.np-top { height: 46px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 14px; border-bottom: 1px solid var(--np-line); }
.np-brand { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 13px; letter-spacing: -.005em; }
.np-brand .mark { width: 20px; height: 20px; border-radius: 6px; background: var(--np-accent-soft); color: var(--np-accent); display: grid; place-items: center; }
.np-top .sp { flex: 1; }
.np-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; }
.np-dot.ok { background: var(--np-green); } .np-dot.bad { background: var(--np-red); }
.np-meta-chip { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 4px; background: var(--np-pill); color: var(--np-muted); font-size: 11px; white-space: nowrap; }

/* 按钮族 */
.np-btn { height: 25px; padding: 0 10px; border-radius: 6px; background: var(--np-pill); color: var(--np-fg2); font-size: 12.5px; transition: background .15s, color .15s, transform .12s var(--np-ease); white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
.np-btn:hover { background: var(--np-pill-hover); color: var(--np-fg); }
.np-btn.on { background: var(--np-accent-soft); color: var(--np-accent); }
.np-btn:disabled { opacity: .45; cursor: default; }
.np-btn-pill { height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11.5px; font-weight: 560; color: var(--np-accent); background: var(--np-accent-soft); box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--np-accent) 35%, transparent); transition: background .15s, color .15s, transform .12s var(--np-ease); }
.np-btn-pill:hover { background: var(--np-accent); color: var(--np-accent-fg); }
.np-btn-pill:disabled { opacity: .5; cursor: default; }
.np-icon { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; color: var(--np-muted); transition: background .15s, color .15s, transform .12s var(--np-ease); }
.np-icon:hover { background: var(--np-pill); color: var(--np-fg); }
.np-icon.on { color: var(--np-accent); background: var(--np-accent-soft); }
.np-icon:disabled { opacity: .35; cursor: default; }
.np-icon.main { width: 30px; height: 30px; color: var(--np-accent-fg); background: var(--np-accent); border-radius: 999px; }
.np-icon.main:hover { filter: brightness(1.06); color: var(--np-accent-fg); background: var(--np-accent); }

/* 主体三栏 */
.np-main { flex: 1; min-height: 0; display: flex; }
.np-rail { width: 168px; flex: none; padding: 8px 8px 10px; border-right: 1px solid var(--np-line); display: flex; flex-direction: column; gap: 2px; overflow: auto; }
.np-rail-group { padding: 8px 8px 4px; font-size: 11px; font-weight: 500; letter-spacing: .04em; color: var(--np-muted); }
.np-nav { display: flex; align-items: center; gap: 9px; height: 30px; padding: 0 9px; border-radius: 7px; font-size: 13px; color: var(--np-fg2); text-align: left; width: 100%; transition: background .14s, color .14s; }
.np-nav:hover { background: var(--np-pill); color: var(--np-fg); }
.np-nav.on { background: var(--np-sel); color: var(--np-accent); font-weight: 500; }
.np-nav .count { margin-left: auto; font-size: 11px; color: var(--np-muted); font-variant-numeric: tabular-nums; }
.np-nav.on .count { color: var(--np-accent); }
.np-rail-foot { margin-top: auto; padding: 8px 9px 0; border-top: 1px solid var(--np-line2); color: var(--np-faint); font-size: 10.5px; line-height: 1.5; }

.np-view { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 10px; }
/* 关键：列向 flex 容器里的子项默认 flex-shrink:1。列表一长，它会被压扁到容器高度，
   再被 .np-list 的 overflow:hidden 裁掉 —— 于是「内容明明很多，却哪儿都滚不动」。
   反过来只给列表放开、其余子项仍可收缩也不行：头部和标签行会被挤成 0 高，
   内容溢出到列表底下（列表后绘制，直接盖住标签行）。
   所以：所有直接子项一律「不伸不缩」（flex: 0 0 auto），高度交给内容，滚动交给 .np-view。 */
.np-view > * { flex: 0 0 auto; }
.np-head { display: flex; align-items: flex-end; gap: 10px; }
.np-head h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
.np-head .sub { color: var(--np-muted); font-size: 11.5px; margin-top: 2px; }
.np-head .sp { flex: 1; }

/* 卡片与列表 */
.np-card { background: var(--np-card); border: 1px solid var(--np-line); border-radius: 12px; overflow: hidden; }
.np-card-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--np-line2); }
.np-card-head .t { font-size: 12.5px; font-weight: 500; }
.np-card-head .sp { flex: 1; }
.np-card-body { padding: 12px; }

.np-list { background: var(--np-card); border: 1px solid var(--np-line); border-radius: 12px; overflow: hidden; }
.np-row { display: grid; grid-template-columns: 24px 32px minmax(0,1fr) 42px 26px auto 26px; align-items: center; gap: 10px; min-height: 46px; padding: 6px 12px 6px 14px; cursor: pointer; }
.np-row + .np-row { border-top: 1px solid var(--np-line2); }
.np-row:hover { background: var(--np-card2); }
.np-row.on { background: var(--np-sel); }
.np-idx { text-align: right; color: var(--np-faint); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.np-row.on .np-idx { color: var(--np-accent); }
.np-cover { width: 32px; height: 32px; border-radius: 6px; object-fit: cover; background: var(--np-pill); display: block; }
.np-meta { min-width: 0; }
.np-name { font-size: 13px; font-weight: 500; letter-spacing: -.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.np-name .flag { display: inline-block; margin-left: 6px; padding: 0 4px; border-radius: 4px; font-size: 9.5px; font-weight: 600; letter-spacing: .04em; vertical-align: 1px; box-shadow: inset 0 0 0 .5px currentColor; }
.np-name .flag.vip { color: var(--np-amber); }
.np-name .flag.down { color: var(--np-red); }
.np-name .flag.trial { color: var(--np-accent); }
.np-sub { font-size: 11.5px; color: var(--np-muted); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.np-sub .why { color: var(--np-accent); }
.np-dur { font-size: 11.5px; color: var(--np-muted); font-variant-numeric: tabular-nums; text-align: right; }
.np-heart { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; color: var(--np-faint); }
.np-heart:hover { background: var(--np-pill); color: var(--np-red); }
.np-heart.on { color: var(--np-red); }
.np-heart:disabled { opacity: .35; cursor: default; }

/* 统计网格（Magpie 招牌：gap:1px 透底线） */
.np-stats { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 1px; background: var(--np-line); border: 1px solid var(--np-line); border-radius: 12px; overflow: hidden; }
.np-stat { background: var(--np-card); padding: 10px 12px; }
.np-stat .k { font-size: 9.5px; font-weight: 600; letter-spacing: .04em; color: var(--np-muted); }
.np-stat .v { font-size: 20px; font-weight: 600; letter-spacing: -.02em; margin-top: 3px; font-variant-numeric: tabular-nums; }
.np-stat .u { font-size: 11px; color: var(--np-muted); margin-left: 3px; font-weight: 400; }

.np-bars { display: flex; flex-direction: column; gap: 7px; }
.np-bar-row { display: grid; grid-template-columns: minmax(0,1fr) 90px 42px; gap: 8px; align-items: center; font-size: 12px; }
.np-bar-row .n { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--np-fg2); }
.np-bar-track { height: 4px; border-radius: 2px; background: var(--np-accent-soft); overflow: hidden; }
.np-bar-fill { height: 100%; border-radius: 2px; background: var(--np-accent); }
.np-bar-row .v { text-align: right; color: var(--np-muted); font-size: 11px; font-variant-numeric: tabular-nums; }

.np-chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.np-label { flex: none; white-space: nowrap; font-size: 11px; color: var(--np-muted); margin-right: 2px; }
.np-tag { height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11.5px; background: var(--np-pill); color: var(--np-fg2); }
.np-tag:hover { background: var(--np-pill-hover); color: var(--np-fg); }
.np-tag.on { background: var(--np-accent-soft); color: var(--np-accent); box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--np-accent) 35%, transparent); }

.np-input { height: 28px; padding: 0 10px; border-radius: 6px; background: var(--np-pill); border: 0; color: var(--np-fg); font-size: 12.5px; width: 100%; }
.np-input::placeholder { color: var(--np-faint); }
.np-search { display: flex; gap: 6px; }
.np-search .np-input { flex: 1; }

.np-empty { padding: 36px 20px; text-align: center; color: var(--np-muted); line-height: 1.7; }
.np-err { padding: 8px 12px; border-radius: 8px; background: var(--np-red-soft); color: var(--np-red); font-size: 12px; }

/* 歌词栏 */
.np-lyric { width: 238px; flex: none; border-left: 1px solid var(--np-line); overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 14px 14px 20px; }
.np-lyric .ln { padding: 4px 0; color: var(--np-muted); font-size: 12px; line-height: 1.5; transition: color .15s; }
.np-lyric .ln.on { color: var(--np-accent); font-weight: 500; }
.np-lyric .tr { font-size: 11px; color: var(--np-faint); }

/* 播放条 */
.np-player { flex: none; min-height: 62px; display: flex; align-items: center; gap: 10px; padding: 0 12px 0 14px; border-top: 1px solid var(--np-line); background: var(--np-card); }
.np-player .np-cover { width: 36px; height: 36px; }
.np-pmeta { width: 168px; min-width: 0; }
.np-pmeta .t { font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.np-pmeta .s { font-size: 11px; color: var(--np-muted); white-space: nowrap; overflow: hidden; display: flex; align-items: center; gap: 5px; }
.np-src { font-size: 9.5px; font-weight: 600; letter-spacing: .04em; padding: 0 4px; border-radius: 4px; background: var(--np-accent-soft); color: var(--np-accent); flex: none; }
.np-prog { flex: 1; min-width: 80px; display: flex; align-items: center; gap: 8px; }
.np-prog input { flex: 1; min-width: 40px; accent-color: var(--np-accent); height: 3px; }
.np-time { font-size: 11px; color: var(--np-muted); font-variant-numeric: tabular-nums; width: 38px; text-align: center; }
.np-vol { width: 66px; accent-color: var(--np-accent); }

/* 标签弹层 */
.np-pop { position: absolute; right: 12px; bottom: 68px; width: 292px; padding: 12px; border-radius: 12px; background: var(--np-card); box-shadow: var(--np-shadow); z-index: 40; display: flex; flex-direction: column; gap: 8px; }
.np-pop .t { font-size: 12px; font-weight: 600; }
.np-pop .hint { font-size: 11px; color: var(--np-muted); }
.np-anchor { position: relative; }

/* 悬窗：面板离开后，它替代播放条。收起态是鲸鱼旁边的一枚「唱片气泡」，
   展开态是带指向尾巴的卡片 —— 和角落里的小鲸鱼是同一族的两个气泡。 */
.np-mini { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  /* 悬窗挂在 body 上、不在面板里，拿不到 .np 上的变量 —— 自己定义一份，
     否则 conic-gradient(var(--np-accent) ...) 整条声明失效，进度环会变成透明的一圈白。 */
  --np-accent: light-dark(#4f46e5, #a5b4fc);
  font: 13px/1.4 -apple-system, "Segoe UI Variable", "Segoe UI", "Inter", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; display: flex; }
.np-mini[hidden] { display: none; }
/* 两种形态互斥：收起时只有唱片，展开时只有卡片 */
.np-mini.is-collapsed .np-mini-card { display: none; background: none; box-shadow: none; border-radius: 0; }
.np-mini.is-collapsed .np-mini-card::after { display: none; }
.np-mini:not(.is-collapsed) .np-mini-disc { display: none; }
.np-mini:not(.is-collapsed) .np-mini-card { display: grid; }
/* 收起态把容器钉死成 46×46 并裁切，杜绝任何内容把浮窗撑大 */
/* 注意：这里**不能** overflow:hidden —— 它会把唱片的 drop-shadow 裁成 46×46 的
   方块残影，在白底上就是一个"正方形底色"（真踩过）。卡片本身是 display:none，
   不需要靠裁切兜底。 */
.np-mini.is-collapsed { width: 46px; height: 46px; overflow: visible; }
.np-mini { max-width: 300px; background: none; box-shadow: none; }

/* 收起态：就一张黑胶唱片（46px 正圆）。
   进度画在**盘面内侧那一圈**（遮罩挖出来），外面不留任何间隙 ——
   否则透明的一圈会把页面底色透出来，看着像「白边」。 */
.np-mini-disc { position: relative; width: 46px; height: 46px; padding: 0; border: 0; background: none;
  cursor: pointer; display: block; border-radius: 50%; -webkit-tap-highlight-color: transparent;
  transition: transform .16s cubic-bezier(.25,.9,.3,1); }
.np-mini-disc:hover { transform: translateY(-1px) scale(1.04); }
.np-mini-disc:active { transform: scale(.96); }

/* 这里的 overflow 会连自己的 drop-shadow 一起裁掉（阴影被切成方块），
   而盘面本身已经用 clip-path: circle(50%) 兜底，不需要再裁。 */
.np-vinyl { position: absolute; inset: 0; width: 46px; height: 46px; border-radius: 50%; aspect-ratio: 1 / 1;
  filter: drop-shadow(0 4px 10px rgba(20, 22, 30, .26)); }

/* 盘面：纹路 + 边缘高光，播放时整块旋转 */
.np-plate { position: relative; width: 100%; height: 100%; aspect-ratio: 1 / 1; border-radius: 50%; overflow: hidden;
  clip-path: circle(50% at 50% 50%); /* 旋转时用裁切保证任何情况下都是正圆 */
  background:
    radial-gradient(circle at 50% 50%, transparent 0 30%, rgba(0,0,0,.45) 30% 33%, transparent 33%),
    repeating-radial-gradient(circle at 50% 50%, rgba(255,255,255,.075) 0 1px, rgba(0,0,0,.06) 1px 3.5px),
    radial-gradient(circle at 34% 28%, #3d3d44 0, #17171a 62%, #0d0d0f 100%);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.10);
  display: grid; place-items: center; }

/* 进度：盘面内侧 2.5px 的一圈彩色弧，其余透明（不旋转） */
.np-vinyl::after { content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  background: conic-gradient(var(--np-accent) 0 var(--np-p, 0%), transparent var(--np-p, 0%));
  -webkit-mask: radial-gradient(circle at 50% 50%, transparent 0 19.5px, #000 19.5px 23px, transparent 23px);
          mask: radial-gradient(circle at 50% 50%, transparent 0 19.5px, #000 19.5px 23px, transparent 23px); }

/* 注意：这里**不能**叫 .np-label —— 搜索页的「最近搜索」文字标签用的就是 .np-label，
   同名规则会把那段文字压成 18×18 的圆（真踩过）。 */
.np-disc-label { width: 18px; height: 18px; border-radius: 50%; background-size: cover; background-position: center;
  box-shadow: 0 0 0 1px rgba(0,0,0,.6), inset 0 0 0 .5px rgba(255,255,255,.28); }
.np-glyph { position: absolute; inset: 0; display: grid; place-items: center; color: #fff;
  filter: drop-shadow(0 1px 1px rgba(0,0,0,.5)); pointer-events: none; }
/* 旋转角度由 JS 按 st.pos 写入（1 秒 = 90°，即 4 秒一圈）：
   暂停时角度正好停在当前进度上，和进度环完全对应，不会再「一直在空转」。 */
.np-plate { will-change: transform; }
@media (prefers-reduced-motion: reduce) { .np-plate { transition: none !important; } }

/* 展开态：带尾巴的卡片，尾巴指向下面的小鲸鱼 */
.np-mini-note { position: absolute; right: 0; bottom: 54px; max-width: 258px; padding: 6px 10px;
  border-radius: 9px; font-size: 11px; line-height: 1.35; white-space: nowrap;
  background: light-dark(#232327, #ededf1); color: light-dark(#ededf1, #232327);
  box-shadow: 0 8px 22px rgba(20,22,30,.22); z-index: 3; }
.np-mini-note[hidden] { display: none; }
/* 空提示条 = 一个带底色的空方块；绝不允许它以任何形态出现 */
.np-mini-note:empty { display: none !important; background: none !important; box-shadow: none !important; }
.np-mini-card { position: relative; box-sizing: border-box; width: 272px; max-width: 272px; max-height: 190px; overflow: hidden;
  display: none; /* 默认不显示；展开态才 display:grid —— 这样 is-collapsed 类万一丢了也不会露出卡片 */
  padding: 10px; border-radius: 14px;
  background: light-dark(#ffffff, #232327); color: light-dark(#1c1c21, #ededf1);
  box-shadow: 0 18px 46px rgba(20,22,30,.20), 0 2px 8px rgba(20,22,30,.08), 0 0 0 .5px rgba(20,22,30,.10);
  grid-template-columns: 40px minmax(0,1fr) auto; gap: 9px 10px; align-items: center;
  transform-origin: 100% 100%; animation: np-card-in .18s cubic-bezier(.25,.9,.3,1); }
@keyframes np-card-in { from { opacity: 0; transform: scale(.94) translateY(6px); } to { opacity: 1; transform: none; } }
.np-mini-card::after { content: ''; position: absolute; right: 20px; bottom: -5px; width: 10px; height: 10px;
  transform: rotate(45deg); border-radius: 2px;
  background: light-dark(#ffffff, #232327);
  box-shadow: 1px 1px 0 0 light-dark(rgba(0,0,0,.10), rgba(255,255,255,.08)); }
.np-mini-card .cover { background: none !important; border-radius: 9px; width: 40px !important; height: 40px !important; max-width: 40px !important; max-height: 40px !important;
  border-radius: 9px; object-fit: cover; display: block;
  }
.np-mini-card .meta { min-width: 0; }
.np-mini-card .t { font-size: 12.5px; font-weight: 600; letter-spacing: -.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.np-mini-card .s { font-size: 11px; color: light-dark(#85858d, #8b8b94); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.np-mini-card .close { width: 22px; height: 22px; border: 0; border-radius: 7px; background: none; cursor: pointer;
  color: light-dark(#85858d, #8b8b94); font-size: 12px; line-height: 1; }
.np-mini-card .close:hover { background: light-dark(#f1f1f4, #2d2d33); color: light-dark(#1c1c21, #ededf1); }
.np-mini-card .bar { grid-column: 1 / -1; height: 3px; border-radius: 3px; overflow: hidden;
  background: light-dark(#eeedfd, #2b2c47); }
.np-mini-card .bar i { display: block; height: 100%; width: 0; border-radius: 3px; background: light-dark(#4f46e5, #a5b4fc); transition: width .2s linear; }
.np-mini-card .row { grid-column: 1 / -1; display: flex; align-items: center; gap: 4px; }
.np-mini-card .time { margin-left: auto; font-size: 10.5px; color: light-dark(#85858d, #8b8b94); font-variant-numeric: tabular-nums; }
.np-mini-card .btn { width: 26px; height: 26px; border: 0; border-radius: 8px; background: none; cursor: pointer;
  color: light-dark(#63636b, #a1a1aa); display: grid; place-items: center; }
.np-mini-card .btn:hover { background: light-dark(#f1f1f4, #2d2d33); color: light-dark(#1c1c21, #ededf1); }
.np-mini-card .fav { color: light-dark(#63636b, #a1a1aa); }
.np-mini-card .fav.on { color: light-dark(#d64545, #f28b82); }
.np-mini-card .main { color: light-dark(#4f46e5, #a5b4fc); background: light-dark(#eeedfd, #2b2c47); }
.np-mini-card .main:hover { background: light-dark(#e4e2fb, #35365c); color: light-dark(#4f46e5, #c7d0ff); }
@media (max-width: 860px) { .np-lyric { display: none; } .np-rail { width: 132px; } .np-pmeta { width: 120px; } .np-vol { display: none; } }
`

    function ensureStyle() {
      try {
        if (typeof document === 'undefined') return
        var old = document.getElementById('dsh-music-style')
        if (old) {
          // 插件热重载时页面没刷新，旧 <style> 还在：内容不同就必须覆盖，
          // 只按 id 判存在会让新面板变成无样式白板。
          if (old.textContent !== CSS) old.textContent = CSS
          return
        }
        var s = document.createElement('style')
        s.id = 'dsh-music-style'
        s.textContent = CSS
        ;(document.head || document.documentElement).appendChild(s)
      } catch (e) { /* 样式注入失败不该拖垮面板 */ }
    }

    function lsGet(k, dflt) {
      try { var v = window.localStorage.getItem(LS + k); return v == null ? dflt : JSON.parse(v) } catch (e) { return dflt }
    }
    function lsSet(k, v) { try { window.localStorage.setItem(LS + k, JSON.stringify(v)) } catch (e) { /* ignore */ } }

    // 浮窗开关按**版本**记账：版本一变（说明用户在升级），旧版本点过的「关掉浮窗」
    // 不再算数，唱片自动回来 —— 否则一次误点 ✕ 就永久消失，而用户根本找不到那个
    // ▣ 开关（真发生过）。
    function readMiniOff() {
      try {
        var raw = JSON.parse(window.localStorage.getItem(LS + 'miniOff') || 'null')
        if (raw && typeof raw === 'object' && 'v' in raw) return raw.v === BUNDLE_VER ? !!raw.on : false
        return false // 旧格式/无记录：一律当作开启
      } catch (e) { return false }
    }

    // 封面统一走网易云的缩略图参数：原图常见 3~5 MB（实测 5,109,324 字节），
    // 46px 的唱片标签/32px 的列表项等一张 5 MB 的图，看起来就是「黑盘」。
    function imgUrl(u, size) {
      if (!u) return ''
      var px = size || 200
      var fixed = /music\.126\.net|126\.net|163\.com/.test(u) && !/[?&]param=/.test(u) ? u + '?param=' + px + 'y' + px : u
      return API + '/img?u=' + encodeURIComponent(fixed)
    }

    // 宿主版本不一致时，路由会 404 且 body 为空；直接 r.json() 只会报
    // "Unexpected end of JSON input"，看不出是「该重启了」。
    function fetchJson(url, opts) {
      return fetch(url, opts).then(function (r) {
        if (r.status === 404) {
          var e = new Error('接口不存在（HTTP 404）—— 宿主插件还是旧版本，重启 DSH 后生效')
          e.httpStatus = 404
          throw e
        }
        if (!r.ok) {
          var e2 = new Error('HTTP ' + r.status)
          e2.httpStatus = r.status
          throw e2
        }
        return r.text().then(function (t) {
          if (!t) { var e3 = new Error('空响应（HTTP ' + r.status + '）'); e3.httpStatus = r.status; throw e3 }
          return JSON.parse(t)
        })
      })
    }
    function fmtSec(sec) {
      var v = Math.max(0, Math.floor(Number(sec) || 0))
      var m = Math.floor(v / 60)
      var s = v % 60
      return m + ':' + (s < 10 ? '0' : '') + s
    }
    function ago(ts) {
      var d = Date.now() - (Number(ts) || 0)
      var m = Math.floor(d / 60000)
      if (m < 1) return '刚刚'
      if (m < 60) return m + ' 分钟前'
      var hr = Math.floor(m / 60)
      if (hr < 24) return hr + ' 小时前'
      var day = Math.floor(hr / 24)
      if (day < 30) return day + ' 天前'
      try { return new Date(ts).toLocaleDateString('zh-CN') } catch (e) { return '' }
    }
    function flagClass(f) { return f === 'VIP' ? 'vip' : f === '下架' ? 'down' : 'trial' }

    function parseLrc(lrc, tlrc) {
      var tr = {}
      if (tlrc) {
        String(tlrc).split(/\r?\n/).forEach(function (line) {
          var m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/)
          if (!m) return
          var t = Math.round((Number(m[1]) * 60 + Number(m[2])) * 100) / 100
          var txt = (m[3] || '').trim()
          if (txt) tr[t] = txt
        })
      }
      var out = []
      String(lrc || '').split(/\r?\n/).forEach(function (line) {
        var re = /\[(\d+):(\d+(?:\.\d+)?)\]/g
        var times = []
        var m
        while ((m = re.exec(line))) times.push(Number(m[1]) * 60 + Number(m[2]))
        var text = line.replace(/\[[^\]]*\]/g, '').trim()
        if (!times.length || !text) return
        times.forEach(function (t) {
          var key = Math.round(t * 100) / 100
          out.push({ t: t, text: text, tr: tr[key] || '' })
        })
      })
      out.sort(function (a, b) { return a.t - b.t })
      return out
    }

    // ── 图标 ──────────────────────────────────────────────────────────────
    var ICONS = {
      music: 'M6.4 12.1V4.2l6.3-1.5v7.7 M4.6 14.1a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6 M12.7 12.2a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6',
      spark: 'M8 2.2v2.6 M8 11.2v2.6 M2.2 8h2.6 M11.2 8h2.6 M4.1 4.1l1.8 1.8 M10.1 10.1l1.8 1.8 M11.9 4.1l-1.8 1.8 M5.9 10.1l-1.8 1.8',
      search: 'M7 12.2a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4Z M10.8 10.8 13.6 13.6',
      chart: 'M2.6 13.2V8.4 M6.1 13.2V3.4 M9.6 13.2V6.6 M13.1 13.2V10',
      heart: 'M8 13.2S2.6 10 2.6 6.4A2.9 2.9 0 0 1 8 4.9a2.9 2.9 0 0 1 5.4 1.5c0 3.6-5.4 6.8-5.4 6.8Z',
      clock: 'M8 14.2A6.2 6.2 0 1 0 8 1.8a6.2 6.2 0 0 0 0 12.4Z M8 4.6V8l2.6 1.7',
      sliders: 'M2.6 5h10.8 M2.6 11h10.8 M6 3v4 M10.5 9v4',
      play: 'M5.4 3.6 12.2 8 5.4 12.4Z',
      pause: 'M5.6 3.6v8.8 M10.4 3.6v8.8',
      prev: 'M4 3.4v9.2 M12.4 3.8 5.8 8l6.6 4.2Z',
      next: 'M12 3.4v9.2 M3.6 3.8 10.2 8l-6.6 4.2Z',
      refresh: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7 M13.4 2.6v3.2h-3.2',
      tag: 'M2.8 2.8h4.6l6 6-4.6 4.6-6-6Z M5.6 5.6h.01',
      download: 'M8 2.6v7.2 M4.8 7.2 8 10.4l3.2-3.2 M2.8 12.8h10.4',
      lyrics: 'M3 4.2h10 M3 8h7 M3 11.8h8.5',
      popup: 'M2.8 3.2h10.4v7.2H2.8Z M5.6 13.4h4.8',
      shuffle: 'M2.6 4.4h2.2l6.6 7.2h2 M2.6 11.6h2.2l2-2.2 M11 3.4l1.9 1-1.9 1 M11 10.6l1.9 1-1.9 1',
    }

    function Icon(props) {
      var d = ICONS[props.name] || ''
      var size = props.size || 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: props.fill ? 'currentColor' : 'none',
        stroke: 'currentColor', strokeWidth: props.stroke || 1.35, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, d.split(' M').map(function (seg, i) {
        return h('path', { key: i, d: i === 0 ? seg : 'M' + seg })
      }))
    }

    // React 没有 hook 版错误边界，用 class；出错时显示一句话而不是白屏
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: '' }
      }
      static getDerivedStateFromError(e) {
        return { error: String((e && e.message) || e) }
      }
      render() {
        if (this.state.error) {
          return h('div', { className: 'np', style: { padding: '24px' } },
            h('div', { className: 'np-err' }, '面板渲染出错：' + this.state.error),
            h('div', { style: { marginTop: '8px', fontSize: '12px', color: '#85858d' } }, '刷新页面即可恢复；若反复出现，把这句话发给我。'))
        }
        return this.props.children
      }
    }

    function Flag(props) {
      return props.flag ? h('span', { className: 'flag ' + flagClass(props.flag) }, props.flag) : null
    }

    function Row(props) {
      var s = props.song
      var on = props.active
      var fav = props.fav
      return h('div', {
        className: 'np-row' + (on ? ' on' : ''),
        'data-song-id': s.id,
        onClick: function () { props.onPlay(s) },
        title: (s.name || '') + (s.artists ? ' — ' + s.artists : ''),
      },
        h('span', { className: 'np-idx' }, on ? '▶' : String(props.index + 1)),
        s.cover
          ? h('img', { className: 'np-cover', src: imgUrl(s.cover), alt: '', loading: 'lazy' })
          : h('div', { className: 'np-cover' }),
        h('div', { className: 'np-meta' },
          h('div', { className: 'np-name' }, s.name || '(无标题)', h(Flag, { flag: s.flag })),
          h('div', { className: 'np-sub' },
            s.reason
              ? h('span', { className: 'why' }, s.reason)
              : [s.artists || '未知歌手', s.album].filter(Boolean).join(' · '))
        ),
        h('span', { className: 'np-dur' }, fmtSec((s.duration || 0) / 1000)),
        h('button', {
          className: 'np-heart' + (fav ? ' on' : ''),
          title: fav ? '取消收藏' : '收藏',
          onClick: function (e) { e.stopPropagation(); props.onFav(s) },
        }, h(Icon, { name: 'heart', size: 14, fill: !!fav })),
        h('span', { className: 'np-dur', style: { whiteSpace: 'nowrap' } }, props.right || ''),
        h('button', {
          className: 'np-icon', style: { width: '24px', height: '24px' },
          title: '播放', onClick: function (e) { e.stopPropagation(); props.onPlay(s) },
        }, h(Icon, { name: 'play', size: 12, fill: true, stroke: 1 }))
      )
    }

    // ── 播放器单例：脱离面板的 React 树，audio 元素挂在 document.body 上 ─────────
    //
    // 面板卸载（切到别的对话/页面）时 React 会拆掉面板的 DOM —— 如果 <audio>
    // 长在面板里，它跟着被回收，歌就断了。所以：
    //   · 唯一的 <audio> 由这里创建，appendChild 到 body，不属于任何组件；
    //   · 播放状态（队列/进度/歌词/音量）也住在这里，组件只订阅；
    //   · 面板不在屏幕上时，body 上挂一个迷你播放条（同样不是 React 组件），
    //     保证切走后仍有暂停/上一首/下一首可用。
    // 单例挂在 window 上：插件热重载时复用同一个播放器，不会出现两个音频在放。
    var MINI_ID = 'dsh-music-mini'

    // 插件热重载（或改完没刷新页面）时，旧 bundle 建在 <body> 上的 #dsh-music-mini
    // 会留在原地，而新 CSS 已经不认旧的 class 名 —— 呈现出来就是
    // 「一个巨大的封面 + 一排默认样式方框按钮」的无样式怪物（本项目实测踩过）。
    // 所以：开场先把没有版本戳的遗留悬窗清掉。
    var BUNDLE_VER = '0.13.1'
    function sweepStaleMini() {
      try {
        if (typeof document === 'undefined') return
        var olds = document.querySelectorAll('#' + MINI_ID)
        for (var i = 0; i < olds.length; i++) {
          // 只要不是当前版本的节点都删：没版本戳的（0.9 之前）和旧版本的（热重载换版本）
          if (olds[i].getAttribute('data-ver') !== BUNDLE_VER) olds[i].remove()
        }
      } catch (e) { /* ignore */ }
    }
    sweepStaleMini()

    function msgOf(e) { return String((e && e.message) || e || '') }

    function getPlayer() {
      var cached = window.__dshMusicPlayer
      if (cached) {
        // 同一版本的控制器直接复用（多个组件共享一个播放器）
        if (cached.__bundle === BUNDLE_VER) return cached
        // 旧版本控制器：它的状态与 DOM 已经和当前 CSS 不匹配。
        // 不杀音频（声音别断），只是不再由它驱动 UI，交给新实例接管。
        try { cached.__retired = true } catch (e) {}
        sweepStaleMini()
      }
      var p = createPlayer()
      p.__bundle = BUNDLE_VER
      window.__dshMusicPlayer = p
      return p
    }

    function createPlayer() {
      var st = {
        song: null, queue: [], idx: -1,
        playing: false, pos: 0, dur: 0,
        vol: lsGet('vol', 0.85),
        repeat: lsGet('repeat', 'all'),
        shuffle: lsGet('shuffle', false),
        info: null, resolving: false,
        lyric: [], lyricIdx: -1,
        err: '',
        panelVisible: true,
        miniOff: readMiniOff(),
        expanded: false,
        scrubbing: false,
      }
      var subs = []
      var panelEl = null
      var miniEl = null
      // 收藏集合：面板本来就有 lib.favorites，同步进来给悬窗显示/切换用
      var favIds = new Set()

      // 热重载会重建控制器，但 <audio> 还挂在 body 上、可能正在放。
      // 直接接管它（沿用节点与播放进度），别让音乐在换 UI 时断掉。
      var audio = null
      try { audio = document.getElementById('dsh-music-audio') } catch (e) { audio = null }
      if (audio && audio.dataset) {
        st.playing = !audio.paused
        st.pos = audio.currentTime || 0
        st.dur = audio.duration || 0
        var idm = /[?&]id=(\d+)/.exec(audio.currentSrc || audio.src || '')
        if (idm) {
          st.song = { id: idm[1], name: '继续播放', artists: '', cover: '', duration: (audio.duration || 0) * 1000 }
          // 占位只是为了让唱片先转起来；马上向宿主要这首歌的真名/封面，把黑唱片补上
          try {
            fetchJson(API + '/api/song?id=' + idm[1])
              .then(function (j) {
                if (j && j.ok && j.song && st.song && String(st.song.id) === String(j.song.id)) {
                  emit({ song: j.song, dur: (j.song.duration || 0) / 1000 || st.dur })
                }
              })
              .catch(function () {})
          } catch (e) { /* ignore */ }
        }
      } else {
        audio = document.createElement('audio')
        audio.id = 'dsh-music-audio'
        audio.preload = 'auto'
        audio.volume = st.vol
        audio.style.display = 'none'
      }
      mountAudio()

      function mountAudio() {
        try {
          var host = document.body || document.documentElement
          if (host && audio.parentNode !== host) host.appendChild(audio)
        } catch (e) { /* 实在挂不上也不影响：元素本身还能播 */ }
      }

      function emit(patch) {
        if (patch) for (var k in patch) st[k] = patch[k]
        // 订阅者必须拿到新的对象引用：React 的 setState 用 Object.is 比较，
        // 反复传同一个可变对象会被判定「没变化」而跳过渲染 ——
        // 那正是「歌名/封面变了、进度条却不动」的根因。
        var snap = null
        for (var i = 0; i < subs.length; i++) {
          if (!snap) snap = Object.assign({}, st)
          try { subs[i](snap) } catch (e) { /* 单个订阅者出错不该影响播放 */ }
        }
        syncMini()
      }

      // ── 订阅 / 面板可见性 ──────────────────────────────────────────────
      function subscribe(fn) {
        subs.push(fn)
        return function () {
          var i = subs.indexOf(fn)
          if (i >= 0) subs.splice(i, 1)
        }
      }

      function panelVisible() {
        if (!panelEl || !panelEl.isConnected) return false
        var r = panelEl.getBoundingClientRect()
        return r.width > 80 && r.height > 60
      }

      function attachPanel(el) {
        panelEl = el
        emit({ panelVisible: panelVisible() })
      }

      function detachPanel() {
        panelEl = null
        emit({ panelVisible: false })
      }

      // 槽位有时是「藏起来」而不是卸载，所以定时量一次尺寸比只靠 unmount 稳
      try {
        setInterval(function () {
          if (st.panelVisible !== panelVisible()) emit({ panelVisible: panelVisible() })
        }, 1200)
      } catch (e) { /* ignore */ }

      // ── 历史记录 ───────────────────────────────────────────────────────
      function recordHistory(song, completed, posSec) {
        try {
          var sec = typeof posSec === 'number' ? posSec : (st.pos || 0)
          fetchJson(API + '/api/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ song: song, playedMs: Math.round(sec * 1000), completed: !!completed }),
          }).catch(function () {})
        } catch (e) { /* ignore */ }
      }

      // ── 播放控制 ───────────────────────────────────────────────────────
      function play(song, queue) {
        if (!song) return
        // 切歌前把上一首真正听了多久报上去（短播放会被宿主判为「跳过」，不进画像）。
        // 原来是在这里给「新歌」上报，那时 st.pos 已置 0，等于每点一首都记 0 毫秒。
        if (st.song && (st.pos || 0) > 0 && st.song.id !== song.id) recordHistory(st.song, false, st.pos)
        if (queue) st.queue = queue.slice()
        st.idx = idxOf(st.queue, song.id)
        st.song = song
        st.pos = 0
        st.dur = (song.duration || 0) / 1000
        st.info = null
        st.resolving = true
        st.lyric = []
        st.lyricIdx = -1
        st.err = ''
        mountAudio()
        audio.src = API + '/stream?id=' + encodeURIComponent(song.id)
        audio.volume = st.vol
        var p = audio.play()
        if (p && p.catch) p.catch(function () { /* 被自动播放策略拦，等用户点播放 */ })
        emit()
        loadLyric(song.id)
        fetchJson(API + '/api/url?id=' + encodeURIComponent(song.id))
          .then(function (j) {
            if (!j || !j.ok) throw new Error((j && j.error) || '解析失败')
            emit({ info: j, resolving: false })
          })
          .catch(function (e) { emit({ resolving: false, err: '无法播放：' + msgOf(e) }) })
      }

      function loadLyric(id) {
        fetchJson(API + '/api/lyric?id=' + encodeURIComponent(id))
          .then(function (j) { if (j && j.ok) emit({ lyric: parseLrc(j.lrc, j.tlrc), lyricIdx: -1 }) })
          .catch(function () {})
      }

      function toggle() {
        if (!audio.getAttribute('src')) {
          var first = st.queue[0] || st.song
          if (first) return play(first, st.queue)
          return
        }
        if (audio.paused) { var p = audio.play(); if (p && p.catch) p.catch(function () {}) }
        else audio.pause()
      }

      function setScrubbing(v) {
        st.scrubbing = !!v
        if (!st.scrubbing) emit({ pos: audio.currentTime || st.pos })
      }

      function setFavorites(ids) {
        favIds = new Set((ids || []).map((x) => String(x && x.id !== undefined ? x.id : x)))
        emit()
      }

      function toggleFavorite() {
        var song = st.song
        if (!song || !song.id) return
        var id = String(song.id)
        var on = !favIds.has(id)
        if (on) favIds.add(id)
        else favIds.delete(id)
        emit() // 先改 UI，点了立刻有反馈
        fetchJson(API + '/api/favorite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ song: song, on: on }),
        }).catch(function () {
          // 失败回滚
          if (on) favIds.delete(id)
          else favIds.add(id)
          emit()
        })
      }

      function setMiniOff(v) {
        st.miniOff = !!v
        lsSet('miniOff', { v: BUNDLE_VER, on: st.miniOff })
        if (!st.miniOff) st.expanded = false
        emit()
      }

      function setExpanded(v) {
        st.expanded = !!v
        emit()
      }

      function seek(sec) {
        var v = Math.max(0, Math.min(Number(sec) || 0, (st.dur || 0) > 0 ? st.dur - 0.2 : 0))
        try { audio.currentTime = v } catch (e) { /* ignore */ }
        st.pos = v
        emit()
      }

      function pickNext(delta) {
        var q = st.queue
        if (!q.length) return -1
        var idx = idxOf(q, st.song && st.song.id)
        if (st.shuffle && q.length > 1) {
          var guard = 0
          var n
          do { n = Math.floor(Math.random() * q.length); guard++ } while (n === idx && guard < 30)
          return n
        }
        var next = idx + delta
        if (next >= q.length) next = st.repeat === 'all' ? 0 : -1
        if (next < 0) next = st.repeat === 'all' ? q.length - 1 : 0
        return next
      }

      function next() {
        var n = pickNext(1)
        if (n >= 0 && st.queue[n]) play(st.queue[n], st.queue)
      }

      function prev() {
        var n = pickNext(-1)
        if (n >= 0 && st.queue[n]) play(st.queue[n], st.queue)
      }

      function setVolume(v) {
        st.vol = Math.max(0, Math.min(1, Number(v) || 0))
        audio.volume = st.vol
        lsSet('vol', st.vol)
        emit()
      }

      function setRepeat(v) {
        st.repeat = v === 'one' ? 'one' : v === 'off' ? 'off' : 'all'
        lsSet('repeat', st.repeat)
        emit()
      }

      function setShuffle(v) {
        st.shuffle = !!v
        lsSet('shuffle', st.shuffle)
        emit()
      }

      // ── 音频事件 ───────────────────────────────────────────────────────
      audio.addEventListener('play', function () { emit({ playing: true }) })
      audio.addEventListener('pause', function () { emit({ playing: false }) })
      audio.addEventListener('loadedmetadata', function () {
        // 切歌瞬间上一首的 metadata 可能迟到，认错时长会让进度条按旧歌走
        var want = st.song ? API + '/stream?id=' + encodeURIComponent(st.song.id) : ''
        var have = audio.getAttribute('src') || ''
        if (want && have && have !== want) return
        emit({ dur: audio.duration || st.dur, pos: audio.currentTime || 0 })
      })
      audio.addEventListener('timeupdate', function () {
        var t = audio.currentTime || 0
        if (st.scrubbing) return // 用户正在拖进度条，别让事件把滑块拽回去
        var idx = lyricIndexAt(st.lyric, t)
        if (idx !== st.lyricIdx) emit({ pos: t, lyricIdx: idx })
        else emit({ pos: t })
        updatePositionState()
      })
      audio.addEventListener('ended', function () {
        if (st.song) recordHistory(st.song, true, st.pos)
        if (st.repeat === 'one') {
          try { audio.currentTime = 0; var p = audio.play(); if (p && p.catch) p.catch(function () {}) } catch (e) { /* ignore */ }
          return
        }
        next()
      })
      audio.addEventListener('error', function () {
        // 宿主和前端版本错位时（/stream 还是旧实现）表现为「点了没声」，
        // 这里给一句能指路的提示，别让用户对着静音发呆。
        emit({
          playing: false,
          err: '音频加载失败。若刚更新过插件，请重启 DSH（宿主 /stream 还是旧实现会直接 400）；否则可能是这条官方直链已经过期，重新点一次播放即可。',
        })
      })

      // ── 系统媒体控制（Windows 音量条 / 键盘媒体键） ────────────────────
      function updatePositionState() {
        try {
          if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
          if (!audio.duration || !isFinite(audio.duration)) return
          navigator.mediaSession.setPositionState({
            duration: audio.duration,
            position: Math.min(audio.currentTime, audio.duration),
            playbackRate: audio.playbackRate || 1,
          })
        } catch (e) { /* ignore */ }
      }

      function syncMediaSession() {
        try {
          if (!('mediaSession' in navigator)) return
          if (st.song && window.MediaMetadata) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: st.song.name || '',
              artist: st.song.artists || '',
              album: st.song.album || '',
              artwork: st.song.cover
                ? [{ src: new URL(imgUrl(st.song.cover, 400), location.href).href, sizes: '200x200', type: 'image/jpeg' }]
                : [],
            })
          }
          navigator.mediaSession.playbackState = st.playing ? 'playing' : 'paused'
        } catch (e) { /* ignore */ }
      }

      try {
        if ('mediaSession' in navigator) {
          navigator.mediaSession.setActionHandler('play', function () { toggle() })
          navigator.mediaSession.setActionHandler('pause', function () { toggle() })
          navigator.mediaSession.setActionHandler('previoustrack', function () { prev() })
          navigator.mediaSession.setActionHandler('nexttrack', function () { next() })
          navigator.mediaSession.setActionHandler('seekto', function (d) { if (d && d.seekTime != null) seek(d.seekTime) })
        }
      } catch (e) { /* 老 Chromium 不支持就算了 */ }

      // ── 迷你播放条（body 上的独立 DOM，不走 React） ────────────────────
      function svgIcon(name, size, fill) {
        var d = ICONS[name] || ''
        var paths = d.split(' M').map(function (seg, i) { return 'M' + seg })
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 16 16" fill="' + (fill ? 'currentColor' : 'none') +
          '" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
          paths.map(function (p, i) { return '<path d="' + (i === 0 ? p.slice(1) : p) + '"/>' }).join('') + '</svg>'
      }

      // 悬窗两种形态：
      //   收起 = 小鲸鱼左边一枚圆形唱片（封面 + 环形进度），和它并排成一个气泡簇；
      //   展开 = 小鲸鱼上方一张带指向尾巴的卡片。
      // 都不碰小鲸鱼的 DOM，只读它的 rect 来定位。
      function ensureMini() {
        // 节点还在但已经被摘出文档：重新挂回去就行，状态/内容都不用重建
        if (miniEl) {
          try {
            var host0 = document.body || document.documentElement
            if (host0 && miniEl.parentNode !== host0) host0.appendChild(miniEl)
          } catch (e) { /* ignore */ }
          return miniEl
        }
        sweepStaleMini()
        if (typeof document === 'undefined') return null
        miniEl = document.createElement('div')
        miniEl.id = MINI_ID
        miniEl.setAttribute('data-ver', BUNDLE_VER)
        miniEl.className = 'np-mini is-collapsed'
        miniEl.hidden = true
        miniEl.innerHTML =
          '<button class="np-mini-disc" data-act="toggle" title="单击 播放/暂停 · 双击 展开播放卡片">' +
            '<span class="np-vinyl"><span class="np-plate">' +
              '<span class="np-disc-label"></span>' +
              '<span class="np-glyph">' + svgIcon('play', 11, true) + '</span>' +
            '</span></span>' +
          '</button>' +
          '<div class="np-mini-note" hidden></div>' +
          '<div class="np-mini-card" data-act="card">' +
            '<img class="cover" width="40" height="40" alt="" data-act="collapse" title="收回成角标" style="cursor:pointer;width:40px;height:40px;max-width:40px;max-height:40px;object-fit:cover" />' +
            '<div class="meta"><div class="t"></div><div class="s"></div></div>' +
            '<button class="close" data-act="close" title="关掉悬窗（可在面板里重新打开）">✕</button>' +
            '<div class="bar"><i></i></div>' +
            '<div class="row">' +
              '<button class="btn" data-act="prev" title="上一首">' + svgIcon('prev', 14) + '</button>' +
              '<button class="btn main" data-act="toggle" title="播放 / 暂停">' + svgIcon('play', 13, true) + '</button>' +
              '<button class="btn" data-act="next" title="下一首">' + svgIcon('next', 14) + '</button>' +
              '<button class="btn fav" data-act="fav" title="喜欢 / 取消喜欢">' + svgIcon('heart', 14) + '</button>' +
              '<span class="time"></span>' +
            '</div>' +
          '</div>'
        miniEl.addEventListener('click', function (e) {
          var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null
          if (!t) return
          var act = t.getAttribute('data-act')
          if (act === 'prev') prev()
          else if (act === 'next') next()
          else if (act === 'toggle') toggle()
          else if (act === 'close') {
            var note = miniEl.querySelector('.np-mini-note')
            if (note) {
              note.textContent = '浮窗已关闭 · 播放条右侧 ▣ 可重新打开'
              note.hidden = false
              setTimeout(function () { setMiniOff(true) }, 2200)
            } else setMiniOff(true)
          }
          else if (act === 'expand') setExpanded(!st.expanded)
          else if (act === 'collapse') setExpanded(false)
          else if (act === 'fav') toggleFavorite()
        })
        // 角标 32px 太小，放不下第二个按钮：单击播放/暂停，双击展开
        miniEl.addEventListener('dblclick', function (e) {
          if (e.target && e.target.closest && e.target.closest('.np-mini-disc')) setExpanded(true)
        })
        miniEl.addEventListener('mouseenter', function () { clearTimeout(collapseTimer) })
        miniEl.addEventListener('mouseleave', function () {
          if (!st.expanded) return
          clearTimeout(collapseTimer)
          collapseTimer = setTimeout(function () { if (st.expanded) setExpanded(false) }, 8000)
        })
        ;(document.body || document.documentElement).appendChild(miniEl)
        return miniEl
      }

      // 定位锚点：优先取小鲸鱼的**本体图片**，而不是它那个 246×246 的固定外框。
      // 外框贴在右下角、比鲸鱼大一圈（CSS: .dshwv-root{right:0;bottom:0;width:246px;height:246px}），
      // 按外框排版会把卡片塞进框里，正好压住鲸鱼本体 —— 之前就是这么错的。
      var SAFE_BOTTOM = 84 // 别压住 DSH 底部的输入条 / 任务按钮
      function anchorRect() {
        try {
          var vw = window.innerWidth
          var vh = window.innerHeight
          var cands = []
          function push(el) {
            if (!el || !el.getBoundingClientRect) return
            var r = el.getBoundingClientRect()
            if (r.width < 16 || r.height < 16) return
            if (r.width > vw * 0.6 || r.height > vh * 0.6) return
            if (r.bottom < 0 || r.top > vh) return
            cands.push(r)
          }
          var root = window.__dshWhaleRoot
          if (root) {
            push(root.querySelector('.dshwv-img'))
            push(root.querySelector('img'))
            push(root)
          }
          if (!cands.length) {
            var imgs = document.querySelectorAll('img')
            for (var i = 0; i < imgs.length && i < 300; i++) {
              var src = imgs[i].currentSrc || imgs[i].src || ''
              if (/whale|dshw|DSH2|DSniang/i.test(src)) { push(imgs[i]); break }
            }
          }
          if (!cands.length) return null
          // 面积最小的那个就是鲸鱼本体（外框总是最大）
          cands.sort(function (a, b) { return a.width * a.height - b.width * b.height })
          return cands[0]
        } catch (e) { return null }
      }

      function placeMini(el) {
        try {
          var a = anchorRect()
          var sig = a ? [a.left, a.top, a.width, a.height].map(Math.round).join(',') : 'none'
          sig += '|' + window.innerWidth + 'x' + window.innerHeight + '|' + (st.expanded ? 'x' : 'c')
          if (sig === lastKey) return
          lastKey = sig
          var vw = window.innerWidth
          var vh = window.innerHeight
          var box = el.getBoundingClientRect()
          var w = box.width || (st.expanded ? 272 : 46)
          var h = box.height || (st.expanded ? 120 : 46)

          if (!st.expanded) {
            // 收起：唱片贴在鲸鱼**左下角外侧**，尽量靠近（右缘只留 1px、底边高 4px）
            if (a) {
              var bRight = Math.max(8, vw - a.left + 1)
              var bBottom = vh - a.bottom + 4
              el.style.right = Math.min(bRight, vw - w - 8) + 'px'
              el.style.bottom = Math.max(8, Math.min(bBottom, vh - h - 8)) + 'px'
            } else {
              el.style.right = '16px'
              el.style.bottom = SAFE_BOTTOM + 'px'
            }
          } else {
            // 展开：卡片底边落在鲸鱼顶部上方 10px（尾巴 5px 正好指着它），右边对齐鲸鱼右缘
            if (a) {
              var right = Math.max(8, vw - a.right)
              right = Math.min(right, Math.max(8, vw - w - 8))
              var bottom = vh - a.top + 10
              var hi = vh - h - 8
              if (hi < 8) hi = 8
              bottom = Math.min(bottom, hi)
              if (bottom < SAFE_BOTTOM) bottom = SAFE_BOTTOM
              el.style.right = right + 'px'
              el.style.bottom = bottom + 'px'
            } else {
              el.style.right = '16px'
              el.style.bottom = SAFE_BOTTOM + 'px'
            }
          }

          // 自校正：摆完量一次，真和鲸鱼本体（或屏幕边缘）打架就继续往上顶。
          // 不去假设鲸鱼内部怎么排版 —— 它可能被拖动、翻转、放大，量出来才算数。
          if (a && st.expanded) {
            for (var pass = 0; pass < 3; pass++) {
              var mb = el.getBoundingClientRect()
              var overlapX = mb.right > a.left - 4 && mb.left < a.right + 4
              var overlapY = mb.bottom > a.top - 4 && mb.top < a.bottom + 4
              if (!(overlapX && overlapY)) break
              var cur = parseFloat(el.style.bottom) || 0
              el.style.bottom = (cur + (a.top - mb.bottom) + 12).toFixed(1) + 'px'
              if (parseFloat(el.style.bottom) > vh - h - 8) { el.style.bottom = (vh - h - 8) + 'px'; break }
            }
          }
        } catch (e) { /* 定位失败就留在原处，不影响播放 */ }
      }

      var collapseTimer = null

      function syncMini() {
        try {
          var show = !!(st.song && !st.panelVisible && !st.miniOff)
          var el = show ? ensureMini() : miniEl
          if (!el) return
          if (show) keepMounted()
          if (!show) {
            el.hidden = true
            lastKey = ''
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
            return
          }
          lastKey = ''
          el.hidden = false
          el.classList.toggle('is-collapsed', !st.expanded)
          el.classList.toggle('is-playing', !!st.playing)

          // 用相对地址（和面板行缩略图完全同一条 URL）：绝对地址在真机上可能因为
          // 端口变化 / 自定义 scheme / 代理前缀而 404，背景图一挂就是一张黑唱片。
          var coverSrc = st.song.cover ? imgUrl(st.song.cover) : ''
          // 只有一张唱片：封面画在中心标签位上
          var label = el.querySelector('.np-disc-label')
          if (label) label.classList.toggle('is-empty', !coverSrc)
          var labelBg = coverSrc ? 'url("' + coverSrc + '")' : 'none'
          if (label.style.backgroundImage !== labelBg) label.style.backgroundImage = labelBg
          var cover = el.querySelector('.np-mini-card .cover')
          if (cover.getAttribute('src') !== coverSrc) cover.setAttribute('src', coverSrc)

          var pct = st.dur > 0 ? Math.max(0, Math.min(100, (st.pos / st.dur) * 100)) : 0
          // 唱片角度 = 进度：4 秒一圈，暂停即停在该角度
          var plate = el.querySelector('.np-plate')
          if (plate) {
            plate.style.transition = st.playing ? 'transform .28s linear' : 'none'
            plate.style.transform = 'rotate(' + ((st.pos || 0) * 90).toFixed(1) + 'deg)'
          }
          el.querySelector('.np-mini-disc').style.setProperty('--np-p', pct.toFixed(2) + '%')
          el.querySelector('.np-mini-card .bar i').style.width = pct.toFixed(1) + '%'

          el.querySelector('.np-mini-card .t').textContent = st.song.name || ''
          el.querySelector('.np-mini-card .s').textContent = st.song.artists || ''
          var favBtn = el.querySelector('.np-mini-card .fav')
          if (favBtn) {
            var isFav = favIds.has(String(st.song.id))
            favBtn.classList.toggle('on', isFav)
            favBtn.title = isFav ? '取消喜欢' : '喜欢'
            favBtn.innerHTML = svgIcon('heart', 14, isFav)
          }
          var noteEl = el.querySelector('.np-mini-note')
          if (noteEl && !noteEl.hidden) noteEl.hidden = true
          el.querySelector('.np-mini-card .time').textContent = fmtSec(st.pos) + ' / ' + fmtSec(st.dur)
          // 角标现在也是 data-act="toggle"，querySelector 会先命中它 ——
          // 必须限定在卡片里，否则这里会把「封套 + 唱片」整个 innerHTML 换成暂停图标
          var main = el.querySelector('.np-mini-card [data-act="toggle"]')
          if (main) main.innerHTML = st.playing ? svgIcon('pause', 13, false) : svgIcon('play', 13, true)
          // 播放时唱片在转，标签位就是封面；暂停时把 ▶ 叠在标签上，一眼看出能点
          var discGlyph = el.querySelector('.np-mini-disc .np-glyph')
          discGlyph.innerHTML = st.playing ? '' : svgIcon('play', 9, true)

          placeMini(el)
          startFollow()
          if (st.expanded) {
            clearTimeout(collapseTimer)
            collapseTimer = setTimeout(function () { if (st.expanded) setExpanded(false) }, 8000)
          }
        } catch (e) { /* 悬窗坏了不影响播放 */ }
      }

      // 跟随鲸鱼：以前是 1.5s 定时器，拖着鲸鱼走会明显「追不上」。
      // 改成 rAF 常驻循环（只在悬窗可见时跑），并且只在锚点真的变了才写样式。
      var rafId = 0
      var lastKey = ''
      function followTick() {
        rafId = 0
        try {
          if (!miniEl || miniEl.hidden) return
          placeMini(miniEl)
        } catch (e) { /* ignore */ }
        rafId = requestAnimationFrame(followTick)
      }
      function startFollow() {
        if (!rafId && typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(followTick)
      }
      // DSH 是 SPA：切视图、或别的客户端插件整体替换 document.body 的子树时，
      // 挂在 body 上的悬窗/音频节点会被顺带摘掉，而我们还捏着这个"孤儿节点"继续更新 ——
      // 表现就是「唱片突然不见了」。这里像小鲸鱼那样做 DOM 守护：一旦不在文档里就补挂回去。
      function keepMounted() {
        try {
          var host = document.body || document.documentElement
          if (miniEl && host && miniEl.parentNode !== host) host.appendChild(miniEl)
          if (audio && host && audio.parentNode !== host) host.appendChild(audio)
        } catch (e) { /* ignore */ }
      }

      try {
        if (typeof MutationObserver === 'function') {
          var lastGuard = 0
          var guard = new MutationObserver(function () {
            var now = Date.now()
            if (now - lastGuard < 400) return   // 节流，别被高频变更拖死
            lastGuard = now
            keepMounted()
          })
          guard.observe(document.documentElement, { childList: true, subtree: true })
        }
        window.addEventListener('resize', function () { if (miniEl && !miniEl.hidden) placeMini(miniEl) })
        window.addEventListener('scroll', function () { if (miniEl && !miniEl.hidden) placeMini(miniEl) }, true)
      } catch (e) { /* ignore */ }

      return {
        get state() { return st },
        snapshot: function () { return st },
        subscribe: subscribe,
        attachPanel: attachPanel,
        detachPanel: detachPanel,
        play: play,
        toggle: toggle,
        next: next,
        prev: prev,
        seek: seek,
        // 本地预览用：直接塞状态，方便截图核对样式（不影响真实播放逻辑）
        __setState: function (patch) { emit(patch || {}) },
        setScrubbing: setScrubbing,
        setMiniOff: setMiniOff,
        setFavorites: setFavorites,
        setExpanded: setExpanded,
        setVolume: setVolume,
        setRepeat: setRepeat,
        setShuffle: setShuffle,
      }
    }

    function idxOf(list, id) {
      for (var i = 0; i < (list || []).length; i++) if (list[i] && list[i].id === id) return i
      return -1
    }

    function lyricIndexAt(lyric, t) {
      if (!lyric || !lyric.length) return -1
      var lo = 0, hi = lyric.length - 1, idx = -1
      while (lo <= hi) {
        var mid = (lo + hi) >> 1
        if (lyric[mid].t <= t + 0.15) { idx = mid; lo = mid + 1 } else hi = mid - 1
      }
      return idx
    }

    // ── 主组件 ────────────────────────────────────────────────────────────
    function Inner() {
      var [view, setView] = useState(lsGet('view', 'discover'))
      var [lib, setLib] = useState({ favorites: [], history: [], plays: {}, tags: {}, profile: null })
      // 本地兜底搜索记录：宿主若是旧版路由（/api/library 不带 searches），
      // 搜索历史照样能记住、能显示，重启后由宿主的记录接管。
      var [lsSearches, setLsSearches] = useState(function () {
        try { return JSON.parse(localStorage.getItem('dsh-music:searches') || '[]') } catch (e) { return [] }
      })
      function pushLocalSearch(q) {
        setLsSearches(function (prev) {
          var kw = String(q || '').trim()
          if (!kw) return prev
          var next = [kw].concat(prev.filter(function (x) { return String(x).toLowerCase() !== kw.toLowerCase() })).slice(0, 12)
          try { localStorage.setItem('dsh-music:searches', JSON.stringify(next)) } catch (e) {}
          return next
        })
      }
      var [health, setHealth] = useState(null)

      // 点侧栏「音乐」会重新挂载面板；把发现结果放 sessionStorage，
      // 重新打开时直接显示上次那批，不自动请求（避免把没听过的歌刷掉）。
      var DISCOVER_CACHE_KEY = 'dsh-music:discover'
      function readDiscoverCache() {
        try {
          var raw = sessionStorage.getItem(DISCOVER_CACHE_KEY)
          if (!raw) return null
          var j = JSON.parse(raw)
          if (!j || !Array.isArray(j.items) || !j.items.length) return null
          if (Date.now() - (j.at || 0) > 30 * 60 * 1000) return null
          return j
        } catch (e) { return null }
      }
      function updateDiscover(next) {
        setDiscoverData(next)
        try {
          if (next && next.items && next.items.length) {
            sessionStorage.setItem(DISCOVER_CACHE_KEY, JSON.stringify({ ...next, at: Date.now() }))
          } else {
            sessionStorage.removeItem(DISCOVER_CACHE_KEY)
          }
        } catch (e) { /* ignore */ }
      }
      var [discoverData, setDiscoverData] = useState(function () {
        return readDiscoverCache() || { items: [], seeds: { artists: [], tags: [] }, coldStart: false, loading: false, tag: '', similarSource: 'none', tasteTags: [], lastfm: false }
      })
      var [kw, setKw] = useState('')
      var [searchSongs, setSearchSongs] = useState([])
      var [searchArtists, setSearchArtists] = useState([])
      var [searchBusy, setSearchBusy] = useState(false)
      var [chartId, setChartId] = useState(CHARTS[0].id)
      var [chartSongs, setChartSongs] = useState([])
      var [chartBusy, setChartBusy] = useState(false)

      // 播放状态全部住在常驻播放器里，组件只订阅 —— 面板卸载不会打断它
      var player = getPlayer()
      var [ps, setPs] = useState(Object.assign({}, player.state))
      var cur = ps.song
      var src = ps.info
      var resolving = ps.resolving
      var playing = ps.playing
      var pos = ps.pos
      var dur = ps.dur
      var vol = ps.vol
      var repeat = ps.repeat
      var shuffle = ps.shuffle
      var lyric = ps.lyric
      var lyricIdx = ps.lyricIdx

      var [showLyric, setShowLyric] = useState(lsGet('showLyric', true))
      var [err, setErr] = useState('')
      var [errKind, setErrKind] = useState('')
      var [popTags, setPopTags] = useState(false)
      var [tagDraft, setTagDraft] = useState('')

      var lyricBoxRef = useRef(null)
      var rootRef = useRef(null)
      var listRef = useRef([])

      // 播放条上的控件直接转给播放器（它自己会持久化音量/循环/随机）
      var setVol = player.setVolume
      var setRepeat = player.setRepeat
      var setShuffle = player.setShuffle

      useEffect(function () { lsSet('view', view) }, [view])
      useEffect(function () { lsSet('showLyric', showLyric) }, [showLyric])
      // 挂载 = 订阅 + 告诉播放器「面板在屏幕上」；卸载只是退订，
      // <audio> 与播放状态都留在 body 上，音乐照放。
      useEffect(function () {
        var unsub = player.subscribe(setPs)
        player.attachPanel(rootRef.current)
        return function () {
          unsub()
          player.detachPanel()
        }
      }, [])

      var favIds = {}
      ;(lib.favorites || []).forEach(function (f) { favIds[f.id] = true })
      function isFav(id) { return !!favIds[String(id)] }

      // ── 数据加载 ────────────────────────────────────────────────────────
      var loadLibrary = useCallback(function () {
        return fetchJson(API + '/api/library')
          .then(function (j) { if (j && j.ok) setLib(j) })
          .catch(function () {})
      }, [])

      var loadHealth = useCallback(function () {
        fetchJson(API + '/api/health').then(setHealth).catch(function () { setHealth(null) })
      }, [])

      var loadDiscover = useCallback(function (tag, opts) {
        setDiscoverData(function (d) { return { ...d, loading: true, tag: tag || '' } })
        var refresh = !!(opts && opts.refresh)
        return fetchJson(API + '/api/discover?limit=40' + (tag ? '&tag=' + encodeURIComponent(tag) : '') + (refresh ? '&refresh=1' : ''))
          .then(function (j) {
            if (!j || !j.ok) throw new Error((j && j.error) || '推荐加载失败')
            var poolSize = Number(j.poolSize) || 0
            var rotated = Number(j.rotated) || 0
            updateDiscover({
              items: j.items || [],
              seeds: j.seeds || { artists: [], tags: [] },
              coldStart: !!j.coldStart,
              loading: false,
              tag: tag || '',
              similarSource: j.similarSource || 'none',
              tasteTags: j.tasteTags || [],
              lastfm: !!j.lastfm,
              batch: Number(j.batch) || 1,
              poolSize: poolSize,
              shownCount: Number(j.shownCount) || 0,
              exhausted: !!j.exhausted,
            })
          })
          .catch(function (e) {
            updateDiscover({ items: [], seeds: { artists: [], tags: [] }, coldStart: false, loading: false, tag: tag || '' })
            setErrKind('discover')
            setErr('推荐加载失败：' + String((e && e.message) || e))
          })
      }, [])

      var [fmKeyInput, setFmKey] = useState('')
      var [keyState, setKeyState] = useState({ lastfm: false, tail: '' })
      var loadKeyState = useCallback(function () {
        fetchJson(API + '/api/settings')
          .then(function (j) { if (j && j.ok) setKeyState({ lastfm: !!j.lastfm, tail: j.lastfmKeyTail || '' }) })
          .catch(function () {})
      }, [])
      var fmSaveKey = useCallback(function (v) {
        return fetchJson(API + '/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lastfmApiKey: String(v || '') }),
        })
          .then(function (j) {
            if (j && j.ok) {
              setKeyState({ lastfm: !!j.lastfm, tail: j.lastfmKeyTail || '' })
              setFmKey('')
              setDiscoverData(function (d) { return { ...d, lastfm: !!j.lastfm } })
            }
          })
          .catch(function (e) { setErrKind('key'); setErr('保存 Last.fm key 失败：' + String((e && e.message) || e)) })
      }, [])

      var loadChart = useCallback(function (id) {
        setChartBusy(true)
        fetchJson(API + '/api/chart?id=' + encodeURIComponent(id))
          .then(function (j) { if (j && j.ok) setChartSongs((j.songs || []).filter(Boolean)) })
          .catch(function () {})
          .then(function () { setChartBusy(false) })
      }, [])

      var doSearch = useCallback(function (q) {
        if (!q) return
        setSearchBusy(true)
        setErr(''); setErrKind('')
        fetchJson(API + '/api/search?q=' + encodeURIComponent(q) + '&limit=60')
          .then(function (j) {
            if (!j || !j.ok) throw new Error((j && j.error) || '搜索失败')
            setSearchSongs((j.songs || []).filter(Boolean))
            setSearchArtists(j.artists || [])
            if (j.limited) {
              setErrKind('search')
              setErr('网易云搜索被限流了（操作频繁）—— 等几分钟再搜；收藏、榜单、推荐不受影响。')
            }
            pushLocalSearch(q)
            if (Array.isArray(j.searches) && j.searches.length) setLib(function (prev) { return { ...prev, searches: j.searches } })
          })
          .catch(function (e) { setErrKind('search'); setErr('搜索失败：' + String((e && e.message) || e)) })
          .then(function () { setSearchBusy(false) })
      }, [])

      useEffect(function () { loadLibrary(); loadHealth(); loadKeyState() }, [loadLibrary, loadHealth, loadKeyState])

      // 收藏状态同步给悬窗：面板是收藏的唯一数据源，悬窗只跟着显示/切换
      useEffect(function () {
        try { player.setFavorites((lib.favorites || []).map(function (x) { return x.id })) } catch (e) {}
      }, [lib.favorites])
      useEffect(function () {
        if (view === 'discover' && !discoverData.items.length && !discoverData.loading) loadDiscover(discoverData.tag || '')
      }, [view]) // eslint-disable-line
      useEffect(function () {
        if (view === 'charts' && !chartSongs.length) loadChart(chartId)
      }, [view]) // eslint-disable-line

      // ── 播放：全部转给常驻播放器，面板只是遥控器 ───────────────────────
      function start(song, queue) {
        if (!song) return
        if (queue) listRef.current = queue
        setErr(''); setErrKind('')
        player.play(song, queue || listRef.current)
        loadLibrary()   // 让「最近/收藏」计数立刻刷新
      }

      function step(delta) {
        if (delta >= 0) player.next()
        else player.prev()
      }

      function togglePlay() { player.toggle() }

      function seek(v) { player.seek(v) }

      // 歌词高亮进度由播放器算好，这里只把当前行滚到中间
      useEffect(function () {
        if (lyricIdx < 0) return
        var box = lyricBoxRef.current
        if (!box) return
        var el = box.querySelector('.ln.on')
        if (el && el.offsetTop) box.scrollTop = Math.max(0, el.offsetTop - box.clientHeight / 2 + 18)
      }, [lyricIdx])

      // 键盘：空格播放/暂停，左右 5 秒
      useEffect(function () {
        function onKey(e) {
          var tag = (e.target && e.target.tagName) || ''
          if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return
          if (e.code === 'Space') { e.preventDefault(); player.toggle() }
          else if (e.key === 'ArrowRight') player.seek(Math.min(Math.max(0, (player.state.dur || 0) - 1), (player.state.pos || 0) + 5))
          else if (e.key === 'ArrowLeft') player.seek(Math.max(0, (player.state.pos || 0) - 5))
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [])

      function toggleFav(song) {
        var on = !isFav(song.id)
        fetchJson(API + '/api/favorite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ song: song, on: on }),
        }).then(function () { loadLibrary() }).catch(function () {})
      }

      function removeFav(song) {
        fetchJson(API + '/api/favorite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ song: song, on: false }),
        }).then(function () { loadLibrary() }).catch(function () {})
      }

      function saveTags(id, tags) {
        fetchJson(API + '/api/tag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, tags: tags }),
        }).then(function () { loadLibrary() }).catch(function () {})
      }

      function playAll(list) {
        if (!list || !list.length) return
        listRef.current = list
        start(list[0], list)
      }

      // ── 派生 ────────────────────────────────────────────────────────────
      var profile = lib.profile || { artists: [], tags: [], totalPlays: 0, favorites: 0, history: 0, basis: null }
      var playingList = listRef.current || []
      var allTags = Array.isArray(lib.presetTags) && lib.presetTags.length ? lib.presetTags : PRESET_TAGS

      function renderRow(s, i, list, extra) {
        var props = {
          key: s.id + '-' + (s.at || i), song: s, index: i,
          active: !!(cur && cur.id === s.id), fav: isFav(s.id),
          onPlay: function (song) { start(song, list) },
          onFav: extra && extra.remove ? removeFav : toggleFav,
        }
        if (extra && extra.right) props.right = extra.right
        return h(Row, props)
      }

      function viewDiscover() {
        return h('div', { className: 'np-view' },
          h('div', { className: 'np-head' },
            h('div', null,
              h('h2', null, '发现'),
              h('div', { className: 'sub' },
                discoverData.coldStart
                  ? '还没有收听记录，先给一份冷启动推荐'
                  : '依据收藏、播放历史与标签' +
                    (discoverData.seeds.artists.length ? ' · 常听 ' + discoverData.seeds.artists.slice(0, 3).join('、') : '') +
                    (discoverData.seeds.tags.length ? ' · 标签 ' + discoverData.seeds.tags.join('、') : '') +
                    (discoverData.similarSource === 'lastfm' ? ' · 相似歌手来自 Last.fm' : ''))
            ),
            h('div', { className: 'sp' }),
            h('button', {
              className: 'np-btn',
              disabled: discoverData.loading,
              title: discoverData.poolSize ? ('候选池 ' + discoverData.poolSize + ' 首 · 每批 40 首') : '换一批推荐',
              onClick: function () { loadDiscover(discoverData.tag, { refresh: true }) },
            }, discoverData.loading
              ? '换一批…'
              : '换一批' + (discoverData.batch > 1 ? ' · 第 ' + discoverData.batch + ' 批' : '')),
            h('button', { className: 'np-btn', onClick: function () { setView('taste') } }, '口味画像')
          ),
          h('div', { className: 'np-chips' },
            [''].concat(allTags.slice(0, 12)).map(function (t) {
              var on = (discoverData.tag || '') === t
              return h('button', {
                key: t || 'all', className: 'np-tag' + (on ? ' on' : ''),
                onClick: function () { loadDiscover(t) },
              }, t || '全部')
            })
          ),
          // 换一批命中缓存时是瞬时的，不要拿空态把整张列表闪掉
          (discoverData.loading && !discoverData.items.length)
            ? h('div', { className: 'np-empty' }, '正在按你的口味找歌…')
            : (discoverData.items.length
              ? h('div', { className: 'np-list' }, discoverData.items.map(function (s, i) { return renderRow(s, i, discoverData.items) }))
              : h('div', { className: 'np-empty' }, discoverData.exhausted
                  ? '推荐过的歌都听完了 · ' + ((profile.basis && profile.basis.shownTtlDays) || 7) + ' 天后自动补新，或在「口味画像」里点「清空推荐记录」'
                  : '这个标签下没找到歌，换个标签试试'))
        )
      }

      function viewSearch() {
        return h('div', { className: 'np-view' },
          h('div', { className: 'np-head' }, h('div', null, h('h2', null, '搜索'), h('div', { className: 'sub' }, '歌名或歌手；回车即搜'))),
          h('div', { className: 'np-search' },
            h('input', {
              className: 'np-input', placeholder: '搜歌名 / 歌手…', value: kw,
              onChange: function (e) { setKw(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') doSearch(kw.trim()) },
            }),
            h('button', { className: 'np-btn-pill', disabled: !kw.trim() || searchBusy, onClick: function () { doSearch(kw.trim()) } }, searchBusy ? '搜索中…' : '搜索')
          ),
          ((lib.searches && lib.searches.length) ? lib.searches : lsSearches.map(function (q) { return { q: q } })).length
            ? h('div', { className: 'np-chips' },
                h('span', { className: 'np-label' }, '最近搜索'),
                ((lib.searches && lib.searches.length) ? lib.searches : lsSearches.map(function (q) { return { q: q } })).map(function (it) {
                  var q = typeof it === 'string' ? it : it.q
                  return h('button', {
                    key: q, className: 'np-tag', title: '再搜一次：' + q,
                    onClick: function () { setKw(q); doSearch(q) },
                  }, q)
                }),
                h('button', {
                  className: 'np-btn', style: { height: '22px', padding: '0 8px', fontSize: '11.5px' },
                  onClick: function () {
                    fetchJson(API + '/api/search-history', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ clear: true }),
                    }).then(function (j) {
                      try { localStorage.removeItem('dsh-music:searches') } catch (e) {}
                      setLsSearches([])
                      setLib(function (prev) { return { ...prev, searches: (j && j.searches) || [] } })
                    }).catch(function () {})
                  },
                }, '清空')
              )
            : null,
          searchArtists.length
            ? h('div', { className: 'np-chips' },
                h('span', { style: { fontSize: '11px', color: 'var(--np-muted)', marginRight: '2px' } }, '歌手'),
                searchArtists.map(function (a) {
                  return h('button', {
                    key: a.id, className: 'np-tag', title: '看 TA 的全部作品（搜索会压 VIP 原唱，歌手页不会）',
                    onClick: function () {
                      setSearchBusy(true)
                      fetchJson(API + '/api/artist?id=' + encodeURIComponent(a.id) + '&name=' + encodeURIComponent(a.name))
                        .then(function (j) { if (j && j.ok) { setSearchSongs((j.songs || []).filter(Boolean)); setSearchArtists([]) } })
                        .catch(function () {})
                        .then(function () { setSearchBusy(false) })
                    },
                  }, a.name)
                })
              )
            : null,
          searchSongs.length
            ? h('div', { className: 'np-list' }, searchSongs.map(function (s, i) { return renderRow(s, i, searchSongs) }))
            : h('div', { className: 'np-empty' }, searchBusy ? '搜索中…' : '搜一首歌开始听')
        )
      }

      function viewCharts() {
        return h('div', { className: 'np-view' },
          h('div', { className: 'np-head' },
            h('div', null, h('h2', null, '榜单'), h('div', { className: 'sub' }, chartSongs.length + ' 首')),
            h('div', { className: 'sp' }),
            h('button', { className: 'np-btn', disabled: !chartSongs.length, onClick: function () { playAll(chartSongs) } }, '播放全部')
          ),
          h('div', { className: 'np-chips' },
            CHARTS.map(function (c) {
              return h('button', {
                key: c.id, className: 'np-tag' + (chartId === c.id ? ' on' : ''),
                onClick: function () { setChartId(c.id); loadChart(c.id) },
              }, c.name)
            })
          ),
          chartBusy && !chartSongs.length
            ? h('div', { className: 'np-empty' }, '加载中…')
            : h('div', { className: 'np-list' }, chartSongs.map(function (s, i) { return renderRow(s, i, chartSongs) }))
        )
      }

      function viewFavorites() {
        var favs = lib.favorites || []
        return h('div', { className: 'np-view' },
          h('div', { className: 'np-head' },
            h('div', null, h('h2', null, '收藏'), h('div', { className: 'sub' }, favs.length + ' 首 · 存在本机，换浏览器也不丢')),
            h('div', { className: 'sp' }),
            h('button', { className: 'np-btn', disabled: !favs.length, onClick: function () { playAll(favs) } }, '播放全部'),
            h('button', { className: 'np-btn', onClick: function () { loadLibrary() } }, '刷新')
          ),
          favs.length
            ? h('div', { className: 'np-list' }, favs.map(function (s, i) {
                return renderRow(s, i, favs, { remove: true, right: s.addedAt ? ago(s.addedAt) : '' })
              }))
            : h('div', { className: 'np-empty' }, '还没有收藏。列表行尾点 ♥，或播放条上点 ♥')
        )
      }

      function viewRecent() {
        var hist = lib.history || []
        return h('div', { className: 'np-view' },
          h('div', { className: 'np-head' },
            h('div', null, h('h2', null, '最近播放'), h('div', { className: 'sub' }, hist.length + ' 条记录，按时间倒序')),
            h('div', { className: 'sp' }),
            h('button', { className: 'np-btn', disabled: !hist.length, onClick: function () { playAll(hist) } }, '从最近播放'),
            h('button', { className: 'np-btn', onClick: function () { loadLibrary() } }, '刷新')
          ),
          hist.length
            ? h('div', { className: 'np-list' }, hist.map(function (s, i) {
                var n = (lib.plays && lib.plays[s.id]) || 0
                var right = ago(s.at) + (n > 1 ? ' · 共 ' + n + ' 次' : '') + (s.skipped ? ' · 未计入' : '')
                return renderRow(s, i, hist, { right: right })
              }))
            : h('div', { className: 'np-empty' }, '还没有播放记录')
        )
      }

      function viewTaste() {
        var basis = profile.basis || { favorites: 0, plays: 0, taggedSongs: 0, decayHalfLifeDays: 14, weights: {} }
        var maxArtist = (profile.artists[0] && profile.artists[0].score) || 1
        var maxTag = (profile.tags[0] && profile.tags[0].score) || 1
        var curTags = cur ? ((lib.tags || {})[cur.id] || []) : []
        var fmKey = fmKeyInput
        return h('div', { className: 'np-view' },
          h('div', { className: 'np-head' },
            h('div', null, h('h2', null, '口味画像'), h('div', { className: 'sub' }, '推荐就是按这张表算出来的')),
            h('div', { className: 'sp' }),
            h('button', { className: 'np-btn', onClick: function () { loadLibrary() } }, '刷新')
          ),
          h('div', { className: 'np-stats' },
            h('div', { className: 'np-stat' }, h('div', { className: 'k' }, 'COLLECTED'), h('div', { className: 'v' }, basis.favorites, h('span', { className: 'u' }, '首'))),
            h('div', { className: 'np-stat' }, h('div', { className: 'k' }, 'PLAYS'), h('div', { className: 'v' }, basis.plays, h('span', { className: 'u' }, '次'))),
            h('div', { className: 'np-stat' }, h('div', { className: 'k' }, 'TAGGED'), h('div', { className: 'v' }, basis.taggedSongs, h('span', { className: 'u' }, '首'))),
            h('div', { className: 'np-stat' }, h('div', { className: 'k' }, 'ARTISTS'), h('div', { className: 'v' }, profile.artists.length, h('span', { className: 'u' }, '位')))
          ),
          h('div', { className: 'np-card' },
            h('div', { className: 'np-card-head' }, h('span', { className: 't' }, '常听歌手'), h('span', { className: 'sp' })),
            h('div', { className: 'np-card-body' },
              profile.artists.length
                ? h('div', { className: 'np-bars' }, profile.artists.slice(0, 8).map(function (a) {
                    return h('div', { className: 'np-bar-row', key: a.name },
                      h('span', { className: 'n' }, a.name),
                      h('div', { className: 'np-bar-track' }, h('div', { className: 'np-bar-fill', style: { width: Math.max(4, Math.round((a.score / maxArtist) * 100)) + '%' } })),
                      h('span', { className: 'v' }, a.count + ' 次')
                    )
                  }))
                : h('div', { className: 'np-empty', style: { padding: '16px 0' } }, '还没有足够数据'))
          ),
          h('div', { className: 'np-card' },
            h('div', { className: 'np-card-head' },
              h('span', { className: 't' }, '风格标签'),
              h('span', { className: 'sp' }),
              h('span', { style: { fontSize: '11px', color: 'var(--np-muted)' } },
                (discoverData.tasteTags || []).length ? 'Last.fm 汇总你常听歌手的标签' : '需要 Last.fm key')),
            h('div', { className: 'np-card-body' },
              (discoverData.tasteTags || []).length
                ? h('div', { className: 'np-chips' }, (discoverData.tasteTags || []).slice(0, 12).map(function (t) {
                    return h('span', { key: t.tag, className: 'np-tag', style: { cursor: 'default' } }, t.tag + (t.count > 1 ? ' ×' + t.count : ''))
                  }))
                : h('div', { className: 'np-empty', style: { padding: '10px 0' } },
                    keyState.lastfm ? '听几首歌、画像里有歌手后重新打开这一页' : '没配 key 时只有「同歌手 + 标签歌单」两条通道'))
          ),
          h('div', { className: 'np-card' },
            h('div', { className: 'np-card-head' },
              h('span', { className: 't' }, 'Last.fm 相似歌手'),
              h('span', { className: 'sp' }),
              h('span', { style: { fontSize: '11px', color: keyState.lastfm ? 'var(--np-green)' : 'var(--np-muted)' } },
                keyState.lastfm ? '已启用 · 末尾 ' + (keyState.tail || '****') : '未配置 · 用同歌手 + 标签兜底')),
            h('div', { className: 'np-card-body', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('div', { style: { fontSize: '11.5px', color: 'var(--np-muted)', lineHeight: '1.55' } },
                '填一个免费的 App key，「发现」就多一条通道：从你常听的歌手出发，找 Last.fm 认为相近的歌手，再取他们在网易云上你还没听过的歌。',
                h('br'),
                h('a', { href: 'https://www.last.fm/api/account/create', target: '_blank', rel: 'noreferrer', style: { color: 'var(--np-accent)' } }, '申请 key（1 分钟，免费）'),
                ' · 这是 app key，不是账号密码；不填也能正常用'),
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('input', {
                  className: 'np-input', placeholder: '粘贴 Last.fm API key', value: fmKey, type: 'password',
                  style: { flex: '1 1 auto', minWidth: 0 },
                  onChange: function (e) { setFmKey(e.target.value) },
                  onKeyDown: function (e) { if (e.key === 'Enter') fmSaveKey(fmKey) },
                }),
                h('button', {
                  className: 'np-btn-pill', disabled: !fmKey.trim(),
                  style: { flex: 'none', whiteSpace: 'nowrap' },
                  onClick: function () { fmSaveKey(fmKey) },
                }, '保存'),
                keyState.lastfm
                  ? h('button', { className: 'np-btn', style: { flex: 'none', whiteSpace: 'nowrap' }, onClick: function () { fmSaveKey('') } }, '清除')
                  : null
              )
            )
          ),
          h('div', { className: 'np-card' },
            h('div', { className: 'np-card-head' }, h('span', { className: 't' }, '标签口味'), h('span', { className: 'sp' }),
              h('span', { style: { fontSize: '11px', color: 'var(--np-muted)' } }, '给歌打标签会让推荐更准')),
            h('div', { className: 'np-card-body' },
              profile.tags.length
                ? h('div', { className: 'np-bars' }, profile.tags.slice(0, 8).map(function (t) {
                    return h('div', { className: 'np-bar-row', key: t.tag },
                      h('span', { className: 'n' }, t.tag),
                      h('div', { className: 'np-bar-track' }, h('div', { className: 'np-bar-fill', style: { width: Math.max(4, Math.round((t.score / maxTag) * 100)) + '%' } })),
                      h('span', { className: 'v' }, t.count + ' 次')
                    )
                  }))
                : h('div', { className: 'np-empty', style: { padding: '16px 0' } }, '还没打过标签'))
          ),
          h('div', { className: 'np-card' },
            h('div', { className: 'np-card-head' },
              h('span', { className: 't' }, '当前播放的标签'), h('span', { className: 'sp' }),
              cur ? h('span', { style: { fontSize: '11px', color: 'var(--np-muted)' } }, cur.name) : null),
            h('div', { className: 'np-card-body' },
              cur
                ? h('div', { className: 'np-chips' },
                    PRESET_TAGS.map(function (t) {
                      var on = curTags.indexOf(t) >= 0
                      return h('button', {
                        key: t, className: 'np-tag' + (on ? ' on' : ''),
                        onClick: function () { saveTags(cur.id, on ? curTags.filter(function (x) { return x !== t }) : curTags.concat(t)) },
                      }, t)
                    })
                  )
                : h('div', { className: 'np-empty', style: { padding: '10px 0' } }, '先放一首歌，再给它打标签'))
          ),
          h('div', { className: 'np-card' },
            h('div', { className: 'np-card-head' }, h('span', { className: 't' }, '推荐依据（怎么算的）')),
            h('div', { className: 'np-card-body', style: { fontSize: '12px', color: 'var(--np-fg2)', lineHeight: '1.75' } },
              h('div', null, '· 收藏歌曲的歌手 +' + (basis.weights.favoriteArtist || 5) + '、标签 +' + (basis.weights.favoriteTag || 3) + '；推荐里遇到收藏歌手的作品再 ×' + (basis.weights.favoriteBoost || 1.25)),
              h('div', null, '· 有效播放（≥ ' + Math.round((basis.minPlayMs || 120000) / 1000) + ' 秒或播完）才计入画像；短播放 ' + (basis.skippedCount || 0) + ' 次已忽略'),
              h('div', null, '· 每次播放歌手 +1、标签 +1，按 ' + basis.decayHalfLifeDays + ' 天半衰期衰减；播完再 ×' + (basis.weights.completedBonus || 1.2)),
              h('div', null, '· 召回两条通道：常听歌手的其他作品（歌手页不受搜索压版权影响）、标签歌单（搜歌单 → 取曲目）'),
              h('div', null, '· 已收藏、最近 30 首、以及 ' + (basis.shownTtlDays || 7) + ' 天内推荐过的 ' + (discoverData.shownCount || basis.shownCount || 0) + ' 首会被排除；每条都标了理由'),
              h('div', { style: { marginTop: '8px' } },
                h('button', {
                  className: 'np-btn',
                  onClick: function () {
                    fetchJson(API + '/api/discover-shown', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ clear: true }),
                    }).then(function () { loadLibrary(); loadDiscover(discoverData.tag) }).catch(function () {})
                  },
                }, '清空推荐记录（' + (discoverData.shownCount || basis.shownCount || 0) + ' 首）')
              ),
              h('div', { style: { marginTop: '6px', color: 'var(--np-muted)', fontSize: '11px' } }, '数据只存在本机，不上传。')
            )
          )
        )
      }

      var badge = src
        ? ('官方直链' + (src.br ? ' ' + Math.round(src.br / 1000) + 'k' : ''))
        : (resolving && cur ? '解析中…' : '')
      var curTags = cur ? ((lib.tags || {})[cur.id] || []) : []

      return h('div', { className: 'np', ref: rootRef },
        h('div', { className: 'np-top' },
          h('div', { className: 'np-brand' },
            h('span', { className: 'mark' }, h(Icon, { name: 'music', size: 12 })),
            h('span', null, '网易云音乐')
          ),
          h('span', { className: 'np-meta-chip' },
            h('span', { className: 'np-dot ' + (health ? 'ok' : 'bad') }),
            health ? '官方接口' : '宿主未连上'),
          health && health.netease
            ? h('span', { className: 'np-meta-chip' },
                h('span', { className: 'np-dot ' + (health.netease.ok ? 'ok' : 'bad') }),
                health.netease.ok ? '网易云连通' : '网易云不通/限流')
            : null,
          h('span', { className: 'sp' }),
          h('button', { className: 'np-btn', onClick: function () { loadHealth(); loadLibrary() } }, h(Icon, { name: 'refresh', size: 12 }), '刷新')
        ),
        err ? h('div', { className: 'np-err', style: { margin: '8px 14px 0' } },
          err,
          (errKind === 'search' || errKind === 'discover')
            ? h('button', {
                className: 'np-btn',
                style: { marginLeft: '8px', height: '20px', padding: '0 8px', fontSize: '11px', verticalAlign: 'middle' },
                onClick: function () {
                  if (errKind === 'search') doSearch(kw.trim())
                  else loadDiscover(discoverData.tag)
                },
              }, '重试')
            : null
        ) : null,
        h('div', { className: 'np-main' },
          h('div', { className: 'np-rail' },
            h('div', { className: 'np-rail-group' }, 'LIBRARY'),
            NAV.map(function (n) {
              var count = n.key === 'favorites' ? (lib.favorites || []).length
                : n.key === 'recent' ? (lib.history || []).length
                  : n.key === 'charts' ? chartSongs.length : null
              return h('button', {
                key: n.key,
                className: 'np-nav' + (view === n.key ? ' on' : ''),
                onClick: function () { setView(n.key) },
              },
                h(Icon, { name: n.icon, size: 14 }),
                h('span', null, n.label),
                count != null && count > 0 ? h('span', { className: 'count' }, count) : null
              )
            }),
            h('div', { className: 'np-rail-foot' }, playingList.length ? '队列 ' + playingList.length + ' 首' : '队列为空')
          ),
          view === 'discover' ? viewDiscover()
            : view === 'search' ? viewSearch()
              : view === 'charts' ? viewCharts()
                : view === 'favorites' ? viewFavorites()
                  : view === 'recent' ? viewRecent()
                    : viewTaste(),
          showLyric
            ? h('div', { className: 'np-lyric', ref: lyricBoxRef },
                lyric.length
                  ? lyric.map(function (l, i) {
                      return h('div', { key: i, className: 'ln' + (i === lyricIdx ? ' on' : '') },
                        l.text, l.tr ? h('div', { className: 'tr' }, l.tr) : null)
                    })
                  : h('div', { className: 'np-empty', style: { padding: '24px 4px', fontSize: '12px' } },
                      cur ? '这首歌没有歌词' : '歌词会在这里跟着走'))
            : null
        ),
        // <audio> 不再长在面板里：播放器单例把它挂在 document.body 上，
        // 面板卸载（切对话/切页面）不会把它带走。
        h('div', { className: 'np-anchor' },
          popTags && cur
            ? h('div', { className: 'np-pop' },
                h('div', { className: 't' }, '给《' + cur.name + '》打标签'),
                h('div', { className: 'hint' }, '标签会影响「发现」里的推荐排序'),
                h('div', { className: 'np-chips' },
                  PRESET_TAGS.map(function (t) {
                    var on = curTags.indexOf(t) >= 0
                    return h('button', {
                      key: t, className: 'np-tag' + (on ? ' on' : ''),
                      onClick: function () { saveTags(cur.id, on ? curTags.filter(function (x) { return x !== t }) : curTags.concat(t)) },
                    }, t)
                  })
                ),
                h('div', { style: { display: 'flex', gap: '6px' } },
                  h('input', {
                    className: 'np-input', placeholder: '自定义标签，回车添加', value: tagDraft,
                    onChange: function (e) { setTagDraft(e.target.value) },
                    onKeyDown: function (e) {
                      if (e.key === 'Enter' && tagDraft.trim()) { saveTags(cur.id, curTags.concat(tagDraft.trim())); setTagDraft('') }
                    },
                  }),
                  h('button', { className: 'np-btn', onClick: function () { setPopTags(false) } }, '关闭')
                )
              )
            : null
        ),
        h('div', { className: 'np-player' },
          cur && cur.cover ? h('img', { className: 'np-cover', src: imgUrl(cur.cover), alt: '' }) : h('div', { className: 'np-cover' }),
          h('div', { className: 'np-pmeta' },
            h('div', { className: 't' }, cur ? cur.name : '未在播放'),
            h('div', { className: 's' },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, cur ? (cur.artists || '未知歌手') : '从发现或搜索里选一首'),
              badge ? h('span', { className: 'np-src' }, badge) : null
            )
          ),
          h('button', {
            className: 'np-heart' + (cur && isFav(cur.id) ? ' on' : ''),
            disabled: !cur, title: cur && isFav(cur.id) ? '取消收藏' : '收藏',
            'aria-label': cur && isFav(cur.id) ? '取消收藏' : '收藏',
            onClick: function () { if (cur) toggleFav(cur) },
          }, h(Icon, { name: 'heart', size: 15, fill: !!(cur && isFav(cur.id)) })),
          h('button', { className: 'np-icon', onClick: function () { step(-1) }, title: '上一首', 'aria-label': '上一首' }, h(Icon, { name: 'prev', size: 14 })),
          h('button', { className: 'np-icon main', onClick: togglePlay, title: playing ? '暂停' : '播放', 'aria-label': playing ? '暂停' : '播放' },
            h(Icon, { name: playing ? 'pause' : 'play', size: 13, fill: !playing, stroke: playing ? 2 : 1 })),
          h('button', { className: 'np-icon', onClick: function () { step(1) }, title: '下一首', 'aria-label': '下一首' }, h(Icon, { name: 'next', size: 14 })),
          h('div', { className: 'np-prog' },
            h('span', { className: 'np-time' }, fmtSec(pos)),
            h('input', {
              type: 'range', min: 0, max: Math.max(1, Math.floor(dur || 0)), step: 1, value: Math.min(pos, Math.floor(dur || 0)),
              onChange: function (e) { seek(Number(e.target.value)) },
              // 拖动期间屏蔽 timeupdate，否则滑块会被事件拽回去（"跟手抖动"）
              onMouseDown: function () { player.setScrubbing(true) },
              onTouchStart: function () { player.setScrubbing(true) },
              onMouseUp: function () { player.setScrubbing(false) },
              onTouchEnd: function () { player.setScrubbing(false) },
              onBlur: function () { player.setScrubbing(false) },
            }),
            h('span', { className: 'np-time' }, fmtSec(dur))
          ),
          h('input', { className: 'np-vol', type: 'range', min: 0, max: 1, step: 0.01, value: vol, onChange: function (e) { setVol(Number(e.target.value)) }, title: '音量' }),
          h('button', { className: 'np-icon' + (popTags ? ' on' : ''), disabled: !cur, title: '打标签', onClick: function () { setPopTags(!popTags) } }, h(Icon, { name: 'tag', size: 14 })),
          h('button', { className: 'np-icon' + (showLyric ? ' on' : ''), title: '歌词', onClick: function () { setShowLyric(!showLyric) } }, h(Icon, { name: 'lyrics', size: 14 })),
          h('button', {
            className: 'np-icon' + (shuffle ? ' on' : ''), title: '随机播放',
            onClick: function () { setShuffle(!shuffle) },
          }, h(Icon, { name: 'shuffle', size: 14 })),
          h('button', {
            className: 'np-icon' + (repeat !== 'off' ? ' on' : ''), title: '循环：列表 / 单曲 / 关',
            onClick: function () { setRepeat(repeat === 'all' ? 'one' : repeat === 'one' ? 'off' : 'all') },
          }, h('span', { style: { fontSize: '10px', fontWeight: 600 } }, repeat === 'one' ? '1' : repeat === 'all' ? '↻' : '→')),
          h('button', {
            className: 'np-icon' + (ps.miniOff ? '' : ' on'),
            title: ps.miniOff ? '打开后台播放浮窗' : '关闭后台播放浮窗（仍可用侧栏图标和媒体键控制）',
            'aria-label': ps.miniOff ? '打开后台播放浮窗' : '关闭后台播放浮窗',
            onClick: function () { player.setMiniOff(!ps.miniOff) },
          }, h(Icon, { name: 'popup', size: 14 })),
          cur
            ? h('a', {
                className: 'np-icon', title: '下载 mp3', download: '',
                href: API + '/stream?id=' + encodeURIComponent(cur.id) + '&dl=' + encodeURIComponent(cur.name + (cur.artists ? ' - ' + cur.artists : '')),
              }, h(Icon, { name: 'download', size: 14 }))
            : null
        )
      )
    }

    // 侧栏图标常驻（切面板不会卸载），正好用来提示「后台还在放」，
    // 也是离开面板后回到播放器的入口。
    function SidebarIcon(props) {
      var p = getPlayer()
      var [st, setSt] = useState(p.state)
      useEffect(function () { return p.subscribe(setSt) }, [])
      var size = (props && props.size) || 16
      return h('span', {
        style: { position: 'relative', display: 'inline-flex' },
        title: st.playing ? '正在播放：' + ((st.song && st.song.name) || '') : '音乐',
      },
        h(Icon, { name: 'music', size: size }),
        st.playing
          ? h('span', {
              style: {
                position: 'absolute', right: '-2px', top: '-2px', width: '5px', height: '5px',
                borderRadius: '50%', background: 'currentColor',
              },
            })
          : null
      )
    }

    var inject = ['slots']

    function apply(ctx) {
      ensureStyle()
      return ctx.slots.inject('main', function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          var stopMain = ctx.slots.register({ name: 'main', key: PANEL_ID }, function () {
            return h(Boundary, null, h(Inner, {}))
          })
          var stopIcon
          try {
            stopIcon = ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 22,
              label: function () { return '音乐' },
            }, SidebarIcon)
          } catch (e) {
            if (typeof stopMain === 'function') stopMain()
            throw e
          }
          return function () {
            if (typeof stopIcon === 'function') stopIcon()
            if (typeof stopMain === 'function') stopMain()
          }
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-music-panel'
    exports.MusicPage = function () { return h(Boundary, null, h(Inner, {})) }
    exports.MusicIcon = SidebarIcon
    return module.exports
  },
})
