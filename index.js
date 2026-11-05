// index.js — dsh-music-panel 宿主侧（Node）。网易云音乐官方接口面板。
//
// 播放能力的唯一来源是网易云官方接口：
//   - 免费曲目、无版权限制的曲目、以及当前账号本来就有权播放的曲目，
//     /api/song/enhance/player/url 会返回可播直链，这里原样代理（支持 Range）。
//   - 需要会员或受地区限制的曲目，官方返回 url:null；本插件不做任何解锁，
//     直接把「该曲目需要官方会员，本插件不提供解锁」返回给前端。
//   - 不内置第三方音源、不代理第三方播放地址、不装外部进程、不碰证书。
//
// 三条硬约束（沿用本机其他插件的经验）：
//   1. 路由注册用 ctx.webServer.register({kind:'exact', path, handler})；
//   2. 工具必须带 output.schema + output.render，只写 schema 会被静默拒收；
//   3. 每个注册单独 try/catch，一个坏路由不该拖垮整个 profile。
//
// 安全边界：/stream 只接受 id，不接受任意 URL——目标地址由宿主自己解析，杜绝 SSRF；
// /img 只放行 *.126.net / *.163.com。
import { Readable } from 'node:stream'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLibrary } from './lib/library.js'
import { discover, DISCOVER_TAGS } from './lib/recommend.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const NE = 'https://music.163.com'

// 加载留痕：profile 里 node_modules 是「复制」不是软链，最常见的故障就是
// 「改了源码但 DSH 还在跑旧副本」。这份日志让「到底加载了哪份代码」一眼可见。
function trace(extra) {
  try {
    const dir = join(process.env.DSH_HOME || join(homedirFallback(), '.dsh'), 'dsh-music-panel-load-logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'plugin-loaded.jsonl'), JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      here: HERE,
      ...extra,
    }) + '\n')
  } catch { /* 日志写不了不能影响插件 */ }
}

// 音质 → 网易云 br 参数
const BR = { standard: 128000, high: 192000, lossless: 999000, exhigh: 320000 }

// 可选：填<自己的>网易云账号 Cookie，搜索结果更准、官方直链也更多（不填也能用）
let neHeaders = { 'User-Agent': UA, Referer: 'https://music.163.com/', Accept: 'application/json, text/plain, */*' }

export const name = 'dsh-music-panel'
export const inject = ['tools']

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const BASE = typeof cfg.basePath === 'string' ? cfg.basePath : '/dsh-netease'
  const QUALITY = BR[cfg.quality] ? cfg.quality : 'exhigh'
  const TTL = Number.isFinite(cfg.cacheTtlMs) ? cfg.cacheTtlMs : 10 * 60 * 1000

  const state = { routes: 0, tools: 0, failed: [] }
  const urlCache = new Map() // id -> { url, source, br, size, at }
  const imgCache = new Map() // url -> { body, type, at }

  // 个人音乐库（收藏 / 历史 / 标签 / 画像），落在 DSH_HOME 下，不随插件副本走
  const library = createLibrary({ dataDir: cfg.dataDir })
  // Last.fm App API key（公开的 app key，不是账号密码）：
  //   config.lastfmApiKey → 环境变量 LASTFM_API_KEY → <dsh-home>/dsh-music-data/settings.json
  //   面板里也能填，POST /api/settings 落盘。
  const settingsFile = join(process.env.DSH_HOME || join(homedirFallback(), '.dsh'), 'dsh-music-data', 'settings.json')
  function loadSettings() {
    try { return JSON.parse(readFileSync(settingsFile, 'utf8')) || {} } catch { return {} }
  }
  function saveSettings(patch) {
    try {
      const next = Object.assign(loadSettings(), patch)
      mkdirSync(dirname(settingsFile), { recursive: true })
      writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8')
      return next
    } catch (e) {
      console.warn('[dsh-music-panel] save settings failed:', msgOf(e))
      return loadSettings()
    }
  }
  let lastfmKey = String(cfg.lastfmApiKey || process.env.LASTFM_API_KEY || '').trim()
  if (!lastfmKey) lastfmKey = String(loadSettings().lastfmApiKey || '').trim()

  // ── 搜索：域名 × 路径 矩阵 + 结果缓存 + 指数冷却 ────────────────────────
  // 实测（2026-11-05）网易云的限流是「按路径」算的，而且和域名无关：
  //   /api/search/get/web   → 4 个域名全部 405「操作频繁」
  //   /api/cloudsearch/pc   → 4 个域名全部正常
  //   /api/search/get       → 4 个域名全部正常
  //   /api/search/suggest/web → 4 个域名全部正常
  // 所以候选不能只写一条路径：按「域名 × 路径」展开成 16 个组合，谁活着用谁，
  // 并记住上次成功的那一条（下次直接命中，不再从最差的开始试）。
  const SEARCH_HOSTS = [
    'https://music.163.com',
    'https://interface.music.163.com',
    'https://interface3.music.163.com',
    'https://interfacepc.music.163.com',
  ]
  const SEARCH_PATHS = [
    // 能活的排前面；已知最易限流的 /web 放最后
    { id: 'cloudsearch', build: (kw, t, l, o) => `/api/cloudsearch/pc?s=${encodeURIComponent(kw)}&type=${t}&limit=${l}&offset=${o}` },
    { id: 'search', build: (kw, t, l, o) => `/api/search/get?s=${encodeURIComponent(kw)}&type=${t}&limit=${l}&offset=${o}` },
    { id: 'suggest', build: (kw, t, l, o) => `/api/search/suggest/web?s=${encodeURIComponent(kw)}&type=${t}&limit=${l}` },
    { id: 'web', build: (kw, t, l, o) => `/api/search/get/web?s=${encodeURIComponent(kw)}&type=${t}&limit=${l}&offset=${o}` },
  ]
  const SEARCH_CACHE_MS = 5 * 60 * 1000   // 同一个词 5 分钟内不再打接口
  const COMBO_BASE_MS = 60 * 1000         // 首次失败冷却 1 分钟
  const COMBO_MAX_MS = 30 * 60 * 1000     // 连续失败最多退到 30 分钟
  const comboCooldown = new Map()         // "host|path" -> until
  const comboFail = new Map()             // "host|path" -> 连续失败次数
  const searchCache = new Map()           // "type|kw|limit|offset" -> { at, j }
  let lastGoodCombo = String((loadSettings().lastGoodSearchCombo) || '')
  let searchServed = 0
  let searchMissed = 0

  async function neFetchAbs(url) {
    const r = await fetch(url, { headers: neHeaders, signal: AbortSignal.timeout(15000) })
    if (!r.ok) throw new Error('网易云 HTTP ' + r.status)
    const text = await r.text()
    return JSON.parse(text.replace(/([^\\]"\s*:\s*)(\d{16,})(\s*[}|,])/g, '$1"$2"$3'))
  }

  function searchCombos() {
    const list = []
    for (const host of SEARCH_HOSTS) {
      for (const p of SEARCH_PATHS) list.push({ combo: host + '|' + p.id, host, p })
    }
    // 上次成功的那条优先；其余保持顺序
    list.sort((a, b) => (b.combo === lastGoodCombo ? 1 : 0) - (a.combo === lastGoodCombo ? 1 : 0))
    return list
  }

  function trimSearchCache() {
    if (searchCache.size <= 80) return
    const entries = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at)
    for (let i = 0; i < entries.length - 60; i++) searchCache.delete(entries[i][0])
  }

  async function neSearch(kw, type, limit, offset) {
    const ck = `${type}|${kw}|${limit}|${offset}`
    const cached = searchCache.get(ck)
    if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) {
      searchServed++
      return { j: cached.j, combo: cached.combo, cached: true }
    }

    let tried = 0
    for (const c of searchCombos()) {
      // suggest 只支持按歌曲搜；搜歌手时跳过它，否则会拿到歌曲数组冒充歌手
      if (type === 100 && c.p.id === 'suggest') continue
      if (Date.now() < (comboCooldown.get(c.combo) || 0)) continue
      tried++
      try {
        const j = await neFetchAbs(c.host + c.p.build(kw, type, limit, offset))
        if (j && (j.code === 405 || j.code === 301)) {
          const n = (comboFail.get(c.combo) || 0) + 1
          comboFail.set(c.combo, n)
          comboCooldown.set(c.combo, Date.now() + Math.min(COMBO_MAX_MS, COMBO_BASE_MS * Math.pow(2, n - 1)))
          continue
        }
        if (j && j.result) {
          comboFail.delete(c.combo)
          comboCooldown.delete(c.combo)
          if (lastGoodCombo !== c.combo) {
            lastGoodCombo = c.combo
            try { saveSettings({ lastGoodSearchCombo: c.combo }) } catch (e) { /* ignore */ }
          }
          searchCache.set(ck, { at: Date.now(), j, combo: c.combo })
          trimSearchCache()
          searchServed++
          return { j, combo: c.combo, tried }
        }
      } catch (e) { /* 换下一个组合 */ }
    }
    searchMissed++
    return null
  }

  function searchStats() {
    return {
      lastGood: lastGoodCombo || null,
      served: searchServed,
      missed: searchMissed,
      cached: searchCache.size,
      cooling: [...comboCooldown.entries()].filter(([, t]) => t > Date.now()).length,
    }
  }

  const discoverCache = new Map() // `${date}|${tag}` -> { at, payload }
  // pool（完整候选池）只留服务端翻页；响应里剔除，避免每次把 120 条回传给前端
  function publicPayload(p) {
    const out = { ...p }
    delete out.pool
    return out
  }
  const discoverRotate = new Map() // 同一个 key 上「换一批」翻到第几个偏移
  const discoverBatch = new Map()   // 同一个 key 上已经发过第几批（给前端显示）

  // 在候选池里按 offset 环形取一页
  function rotatePage(pool, offset, limit) {
    if (!Array.isArray(pool) || !pool.length) return []
    const n = pool.length
    const start = ((offset % n) + n) % n
    const out = []
    for (let i = 0; i < n && out.length < limit; i++) out.push(pool[(start + i) % n])
    return out
  }

  // 可选网易云 Cookie：原样透传（用自己账号的登录态时搜索结果更接近网页版）。
  // 不在这里拼任何字段名，也不做「没填就伪造一个」的处理。
  const cookie = String(cfg.cookie || process.env.NETEASE_COOKIE || '').trim()
  if (cookie) neHeaders = { ...neHeaders, Cookie: cookie }

  async function resolvePlay(rawId) {
    const id = String(rawId || '').replace(/[^\d]/g, '')
    if (!id) throw new Error('缺少歌曲 id')
    const hit = urlCache.get(id)
    if (hit && Date.now() - hit.at < TTL) return hit

    // 只问网易云官方：官方给直链就用，不给就明确告诉用户原因，不做任何替代放音。
    let d = null
    try {
      const j = await neGet(`/api/song/enhance/player/url?id=${id}&ids=%5B${id}%5D&br=${BR[QUALITY]}`)
      d = j && Array.isArray(j.data) ? j.data[0] : null
    } catch (e) {
      throw new Error('网易云播放接口请求失败：' + msgOf(e))
    }
    if (!d || !d.url || d.freeTrialInfo) {
      // fee: 1=VIP 曲目、4=付费专辑、8=低音质免费；freeTrialInfo 非空 = 只给试听片段
      const why = d && d.freeTrialInfo
        ? '官方只提供试听片段'
        : (d && (d.fee === 1 || d.fee === 4) ? '官方标记为会员/付费曲目' : '官方没有返回可播地址（可能已下架或本地区不可用）')
      throw new Error('该曲目需要官方会员，本面板只播放官方允许的内容（' + why + '）')
    }
    const rec = { url: d.url, source: 'netease', br: d.br || BR[QUALITY], size: d.size || 0, official: true, id, at: Date.now() }
    urlCache.set(id, rec)
    return rec
  }

  function forget(id) { urlCache.delete(String(id)) }

  // 官方直链要带网易的 Referer 才不会被 403
  function refererFor(u) {
    const h = u.hostname
    if (h.endsWith('.126.net') || h.endsWith('.163.com') || h.endsWith('.163yun.com')) return 'https://music.163.com/'
    return u.origin + '/'
  }

  async function pipeAudio(req, res, id, dlName) {
    let rec = await resolvePlay(id)
    let attempt = 0
    let upstream = null
    while (attempt < 2) {
      const u = new URL(rec.url)
      assertPublicHttp(u)
      const headers = { 'User-Agent': UA, Referer: refererFor(u), Accept: '*/*' }
      if (req.headers.range) headers.Range = req.headers.range
      upstream = await fetch(u, { headers, signal: AbortSignal.timeout(45000) })
      if (upstream.status < 400) break
      // 直链会过期：命中 4xx 就丢掉缓存、重新解析一次
      if (attempt === 0 && [403, 404, 410, 416].includes(upstream.status)) {
        forget(id)
        rec = await resolvePlay(id)
        attempt++
        continue
      }
      break
    }
    const h = {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Music-Source': rec.source,
      'X-Music-Bitrate': String(rec.br || ''),
    }
    for (const k of ['content-length', 'content-range', 'last-modified', 'etag']) {
      const v = upstream.headers.get(k)
      if (v) h[k.replace(/(^|-)([a-z])/g, (_m, p, c) => p + c.toUpperCase())] = v
    }
    if (dlName) h['Content-Disposition'] = 'attachment; filename="' + encodeURIComponent(dlName) + '.mp3"'
    res.writeHead(upstream.status, h)
    if (!upstream.body) return res.end()
    const body = Readable.fromWeb(upstream.body)
    res.on('close', () => { try { body.destroy() } catch { /* 客户端断开 */ } })
    body.on('error', () => { try { res.end() } catch { /* ignore */ } }).pipe(res)
  }

  // 封面也走宿主：源站有时只给 http:// 图，页面是 https 时会被混合内容拦
  const IMG_MAX_BYTES = 4 * 1024 * 1024      // 单张上限（缩略图远小于此）
  const IMG_CACHE_MAX = 24 * 1024 * 1024     // 缓存总字节上限，避免内存放大
  let imgCacheBytes = 0

  function allowedImageHost(u) {
    if (u.protocol !== 'https:') return false
    if (u.port && u.port !== '443') return false        // 禁止借白名单域名探任意端口
    if (u.username || u.password) return false
    return /(^|\.)(126\.net|163\.com|163yun\.com)$/i.test(u.hostname)
  }

  // 手动跟随重定向：每跳都重新校验，防止白名单域名 302 到内网/任意地址
  async function fetchImage(start) {
    let cur = start
    for (let hop = 0; hop < 3; hop++) {
      const r = await fetch(cur, {
        headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
        redirect: 'manual', signal: AbortSignal.timeout(15000),
      })
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location')
        if (!loc) return null
        let next
        try { next = new URL(loc, cur) } catch { return null }
        if (!allowedImageHost(next)) return null
        cur = next
        continue
      }
      return r
    }
    return null
  }

  async function pipeImage(req, res, rawUrl) {
    let u
    try { u = new URL(capStr(rawUrl, 2048)) } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }) }
    // 兼容旧数据里的 http:// 封面：升级为 https 再走白名单校验
    if (u.protocol === 'http:') u = new URL('https://' + u.href.slice('http://'.length))
    if (!allowedImageHost(u)) return sendJson(res, 403, { ok: false, error: 'host not allowed' })
    const ck = u.href
    const hit = imgCache.get(ck)
    if (hit && Date.now() - hit.at < 86400000) {
      res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': String(hit.body.length), 'Cache-Control': 'public, max-age=86400' })
      return res.end(hit.body)
    }
    const r = await fetchImage(u)
    if (!r) return sendJson(res, 502, { ok: false, error: '重定向到不允许的地址' })
    if (!r.ok) return sendJson(res, 502, { ok: false, error: 'upstream ' + r.status })
    const cl = Number(r.headers.get('content-length') || 0)
    if (cl > IMG_MAX_BYTES) return sendJson(res, 502, { ok: false, error: '图片过大' })
    const body = Buffer.from(await r.arrayBuffer())
    if (body.length > IMG_MAX_BYTES) return sendJson(res, 502, { ok: false, error: '图片过大' })
    const type = r.headers.get('content-type') || 'image/jpeg'
    if (imgCacheBytes + body.length > IMG_CACHE_MAX) { imgCache.clear(); imgCacheBytes = 0 }
    imgCache.set(ck, { body, type, at: Date.now() })
    imgCacheBytes += body.length
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(body.length), 'Cache-Control': 'public, max-age=86400' })
    res.end(body)
  }

  // ── 路由 ───────────────────────────────────────────────────────────────
  const root = ctx.root ?? ctx
  try {
    root.inject(['webServer'], async (c) => {
      const webServer = c.webServer ?? c.get?.('webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        state.failed.push({ stage: 'no-webServer' })
        return
      }

      const routes = [
        {
          kind: 'exact',
          path: `${BASE}/api/search`,
          handler: async (req, res) => {
            try {
              const q = new URL(req.url || '/', 'http://127.0.0.1')
              const kw = capStr(q.searchParams.get('q'), 60)
              if (!kw) return sendJson(res, 400, { ok: false, error: '缺少 q 参数' })
              const limit = clamp(q.searchParams.get('limit'), 30, 1, 100)
              const offset = clamp(q.searchParams.get('offset'), 0, 0, 1000)
              // 同时搜歌和歌手：网易云对未登录用户的歌曲搜索会压掉 VIP 原唱
              // （搜「晴天」前几名全是翻唱），但歌手页能列出全部作品，所以两个都查。
              const [songHit, artistHit] = await Promise.all([
                neSearch(kw, 1, limit, offset),
                neSearch(kw, 100, 6, 0),
              ])
              const j = songHit && songHit.j
              if (!j) throw new Error('网易云的搜索接口全部被限流了，等一两分钟再试')
              const songs = await enrichSongs(((j && j.result && j.result.songs) || []).map(normalize).filter(Boolean))
              const artists = artistHit
                ? (((artistHit.j.result || {}).artists) || []).map((a) => ({
                    id: String(a.id),
                    name: String(a.name || ''),
                    cover: String(a.picUrl || a.img1v1Url || '').replace('http://', 'https://'),
                  }))
                : []
              // 网易云限流/未登录时返回 {code:405,"操作频繁"} 或 {code:301,"未登录"}。
              // 那不是「没结果」，前端要能区分，否则用户只看到空列表还以为插件坏了。
              const limited = !!(j && (j.code === 405 || j.code === 301))
              const searches = limited ? library.searches() : library.addSearch(kw)
              sendJson(res, 200, { ok: true, keyword: kw, searches, limited, total: (j && j.result && j.result.songCount) || songs.length, songs, artists })
            } catch (e) {
              sendJson(res, 502, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/api/chart`,
          handler: async (req, res) => {
            try {
              const q = new URL(req.url || '/', 'http://127.0.0.1')
              const id = (q.searchParams.get('id') || '3778678').replace(/[^\d]/g, '') || '3778678'
              const j = await neGet(`/api/playlist/detail?id=${id}&n=1000`)
              const r = j && (j.result || j.playlist)
              if (!r) throw new Error('榜单数据为空')
              const songs = await enrichSongs((r.tracks || []).map(normalize).filter(Boolean))
              sendJson(res, 200, { ok: true, id, name: r.name || '榜单', count: songs.length, songs })
            } catch (e) {
              sendJson(res, 502, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          // 歌手页：搜索接口会压掉 VIP 原唱，歌手页列的是全部作品
          kind: 'exact',
          path: `${BASE}/api/artist`,
          handler: async (req, res) => {
            try {
              const q = new URL(req.url || '/', 'http://127.0.0.1')
              const id = (q.searchParams.get('id') || '').replace(/[^\d]/g, '')
              if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
              const name = q.searchParams.get('name') || ''
              // v2 间歇性 400，v1 稳定：两个都试
              let j = null
              for (const ep of [
                `/api/v2/artist/songs?id=${id}&limit=200&offset=0`,
                `/api/v1/artist/songs?id=${id}&limit=200&offset=0`,
              ]) {
                try {
                  const r = await neGet(ep)
                  if (r && Array.isArray(r.songs) && r.songs.length) { j = r; break }
                } catch (e) { /* next */ }
              }
              const songs = await enrichSongs((j.songs || []).map(normalize).filter(Boolean))
              sendJson(res, 200, { ok: true, id, name, count: songs.length, songs })
            } catch (e) {
              sendJson(res, 502, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          // 解析播放地址：只走官方；需要会员/受地区限制的曲目会返回明确的错误
          kind: 'exact',
          path: `${BASE}/api/url`,
          handler: async (req, res) => {
            try {
              const q = new URL(req.url || '/', 'http://127.0.0.1')
              const id = q.searchParams.get('id') || ''
              const rec = await resolvePlay(id)
              sendJson(res, 200, {
                ok: true,
                id: rec.id,
                source: rec.source,
                official: !!rec.official,
                br: rec.br,
                size: rec.size,
                stream: `${BASE}/stream?id=${rec.id}`,
                raw: rec.url.replace(/[?&](token|auth|sign)=[^&]*/gi, '$1=***'),
              })
            } catch (e) {
              sendJson(res, 502, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          // 单曲元数据：热重载后前端接管音频时，用它把「继续播放」占位换成真歌名/封面
          kind: 'exact',
          path: `${BASE}/api/song`,
          handler: async (req, res) => {
            try {
              const q = new URL(req.url || '/', 'http://127.0.0.1')
              const id = (q.searchParams.get('id') || '').trim()
              if (!/^\d+$/.test(id)) return sendJson(res, 400, { ok: false, error: '缺少数字 id' })
              const j = await neGet(`/api/song/detail?ids=[${id}]`)
              const raw = j && j.songs && j.songs[0]
              const song = raw ? normalize(raw) : null
              if (!song) return sendJson(res, 404, { ok: false, error: '没找到这首歌' })
              sendJson(res, 200, { ok: true, song })
            } catch (e) {
              sendJson(res, 502, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          // 口味扩展用的 Last.fm App key：GET 查状态，POST 设置（空串=清除）
          kind: 'exact',
          path: `${BASE}/api/settings`,
          handler: async (req, res) => {
            try {
              if (req.method === 'POST') {
                if (isCrossSite(req)) return sendJson(res, 403, { ok: false, error: '跨站请求已拒绝' })
                const body = await readJson(req)
                if (typeof body.lastfmApiKey === 'string') {
                  lastfmKey = capStr(body.lastfmApiKey, 128)
                  saveSettings({ lastfmApiKey: lastfmKey })
                  discoverCache.clear()
                }
              }
              sendJson(res, 200, { ok: true, lastfm: !!lastfmKey, lastfmKeyTail: lastfmKey ? lastfmKey.slice(-4) : '' })
            } catch (e) {
              sendJson(res, 400, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          // ── 个人音乐库 ─────────────────────────────────────────────────
          kind: 'exact',
          path: `${BASE}/api/library`,
          handler: async (_req, res) => {
            try {
              // 注意：snapshot().tags 是「每首歌的标签表」，预设标签另起字段名，别覆盖
              sendJson(res, 200, { ok: true, ...library.snapshot(), presetTags: DISCOVER_TAGS })
            } catch (e) {
              sendJson(res, 502, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/api/favorite`,
          handler: async (req, res) => {
            try {
              if (isCrossSite(req)) return sendJson(res, 403, { ok: false, error: '跨站请求已拒绝' })
              const body = await readJson(req)
              const out = library.toggleFavorite(body.song || body, body.on)
              sendJson(res, 200, { ...out, favorites: library.favorites() })
            } catch (e) {
              sendJson(res, 400, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/api/history`,
          handler: async (req, res) => {
            try {
              if (isCrossSite(req)) return sendJson(res, 403, { ok: false, error: '跨站请求已拒绝' })
              const body = await readJson(req)
              const out = library.recordPlay(body.song || body, { playedMs: body.playedMs, completed: body.completed })
              sendJson(res, 200, out)
            } catch (e) {
              sendJson(res, 400, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          // 搜索历史：POST { clear:true } 清空；不传参也能拿来读
          kind: 'exact',
          path: `${BASE}/api/search-history`,
          handler: async (req, res) => {
            try {
              if (req.method === 'POST') {
                if (isCrossSite(req)) return sendJson(res, 403, { ok: false, error: '跨站请求已拒绝' })
                const body = await readJson(req)
                if (body && body.clear) library.clearSearches()
                else if (body && body.q) library.addSearch(body.q)
              }
              sendJson(res, 200, { ok: true, searches: library.searches() })
            } catch (e) {
              sendJson(res, 400, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/api/tag`,
          handler: async (req, res) => {
            try {
              if (isCrossSite(req)) return sendJson(res, 403, { ok: false, error: '跨站请求已拒绝' })
              const body = await readJson(req)
              const out = library.setTags(body.id || (body.song && body.song.id), body.tags)
              sendJson(res, 200, { ...out, profile: library.profile() })
            } catch (e) {
              sendJson(res, 400, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          // 推荐流：?tag= 只看某个标签；?limit=30；?refresh=1 换一批。
          // 曝光去重：返回过的 id 记入 library.shown（7 天 TTL），
          // 三条返回分支统一过滤，换一批不会再把第一批翻回来。
          kind: 'exact',
          path: `${BASE}/api/discover`,
          handler: async (req, res) => {
            try {
              const q = new URL(req.url || '/', 'http://127.0.0.1')
              const tag = capStr(q.searchParams.get('tag'), 40)
              const limit = clamp(q.searchParams.get('limit'), 30, 1, 60)
              const day = new Date().toISOString().slice(0, 10)
              const key = `${day}|${tag}|${limit}|${lastfmKey ? 'fm' : 'nfm'}`
              const refresh = q.searchParams.get('refresh') === '1'
              const batch = refresh ? (discoverBatch.get(key) || 1) + 1 : (discoverBatch.get(key) || 1)
              if (refresh) discoverBatch.set(key, batch)
              const shownSet = new Set(library.shownIds())
              const notShown = (arr) => (Array.isArray(arr) ? arr : []).filter((x) => x && !shownSet.has(String(x.id)))
              const uniq = (arr) => {
                const seen = new Set()
                return arr.filter((x) => { const id = String(x.id); if (seen.has(id)) return false; seen.add(id); return true })
              }

              async function compute() {
                const prof = library.profile()
                const exclude = new Set([
                  ...library.favorites().map((x) => x.id),
                  ...library.history(30).map((x) => x.id),
                  ...shownSet,
                ])
                const rec = await discover({ neGet, normalize, profile: prof, tag, limit, excludeIds: [...exclude], lastfmKey, favoriteArtists: prof.favoriteArtists })
                const items = await enrichSongs(rec.items).catch(() => rec.items)
                return {
                  tag: tag || '',
                  coldStart: rec.coldStart,
                  seeds: rec.seeds,
                  profile: { artists: prof.artists.slice(0, 5), tags: prof.tags.slice(0, 5), basis: prof.basis },
                  stats: rec.stats || null,
                  similarSource: rec.similarSource || 'none',
                  tasteTags: rec.tasteTags || [],
                  lastfm: !!lastfmKey,
                  items,
                  pool: rec.pool || items,
                }
              }

              const hit = discoverCache.get(key)
              const fresh = hit && Date.now() - hit.at < 30 * 60 * 1000
              // 只是「打开面板 / 切回来看一眼」：把上一批原样还回去。
              // 以前这里会重新过滤 + markShown，等于光看一眼就把没听过的歌消耗掉。
              if (!refresh && fresh && Array.isArray(hit.lastItems) && hit.lastItems.length) {
                return sendJson(res, 200, {
                  ok: true, cached: true, rotated: hit.lastRotated || 0,
                  poolSize: hit.lastPoolSize || 0, batch: hit.lastBatch || 1,
                  shownCount: library.shownIds().length, exhausted: false,
                  ...publicPayload(hit.payload), items: hit.lastItems,
                })
              }
              let payload = fresh ? hit.payload : null
              if (!payload) {
                payload = await compute()
                discoverCache.set(key, { at: Date.now(), payload })
                if (discoverCache.size > 24) discoverCache.clear()
              }

              const pool = uniq(notShown(payload.pool || []))
              let items
              let rotated = 0
              if (refresh) {
                const off = (discoverRotate.get(key) || 0) + limit
                discoverRotate.set(key, off)
                rotated = off % Math.max(1, pool.length)
                items = rotatePage(pool, off, limit)
              } else {
                items = uniq(notShown(payload.items || [])).slice(0, limit)
                for (const s of pool) {
                  if (items.length >= limit) break
                  if (!items.some((x) => String(x.id) === String(s.id))) items.push(s)
                }
              }

              // 池子被推荐光了：丢缓存重算一轮（exclude 已含 shown，算出来必是新歌）
              if (!items.length) {
                discoverCache.delete(key)
                payload = await compute()
                discoverCache.set(key, { at: Date.now(), payload })
                const pool2 = uniq(notShown(payload.pool || []))
                items = refresh ? rotatePage(pool2, 0, limit) : uniq(notShown(payload.items || [])).slice(0, limit)
                rotated = 0
              }

              const out = items.slice(0, limit)
              const entry = discoverCache.get(key) || { at: Date.now(), payload }
              entry.payload = payload
              entry.lastItems = out
              entry.lastBatch = batch
              entry.lastRotated = rotated
              entry.lastPoolSize = pool.length
              discoverCache.set(key, entry)
              library.markShown(out.map((x) => x.id))   // 只有新的一批才消耗曝光
              sendJson(res, 200, {
                ok: true, cached: !!hit, rotated, poolSize: pool.length, batch,
                shownCount: library.shownIds().length, exhausted: out.length === 0,
                ...publicPayload(payload), items: out,
              })
            } catch (e) {
              sendJson(res, 502, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          // 推荐曝光记录：GET 查数量；POST {clear:true} 清空（让用户能立刻重看）
          kind: 'exact',
          path: `${BASE}/api/discover-shown`,
          handler: async (req, res) => {
            try {
              if (req.method === 'POST') {
                if (isCrossSite(req)) return sendJson(res, 403, { ok: false, error: '跨站请求已拒绝' })
                const body = await readJson(req)
                if (body && body.clear) {
                  library.clearShown()
                  discoverCache.clear()
                  discoverRotate.clear()
                  discoverBatch.clear()
                }
              }
              sendJson(res, 200, { ok: true, count: library.shownIds().length })
            } catch (e) {
              sendJson(res, 400, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/api/lyric`,
          handler: async (req, res) => {
            try {
              const q = new URL(req.url || '/', 'http://127.0.0.1')
              const id = (q.searchParams.get('id') || '').replace(/[^\d]/g, '')
              if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
              const j = await neGet(`/api/song/lyric?id=${id}&lv=-1&kv=-1&tv=-1`)
              sendJson(res, 200, {
                ok: true,
                lrc: (j && j.lrc && j.lrc.lyric) || '',
                tlrc: (j && j.tlyric && j.tlyric.lyric) || '',
                noLyric: !!(j && j.nolyric),
              })
            } catch (e) {
              sendJson(res, 502, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/stream`,
          handler: async (req, res) => {
            try {
              const q = new URL(req.url || '/', 'http://127.0.0.1')
              const id = (q.searchParams.get('id') || '').replace(/[^\d]/g, '')
              if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
              // searchParams 已经解码过一次，别再 decodeURIComponent（歌名里有 % 会抛 URIError）
              const dl = capStr(q.searchParams.get('dl'), 120)
              await pipeAudio(req, res, id, dl)
            } catch (e) {
              if (!res.headersSent) sendJson(res, 502, { ok: false, error: msgOf(e) })
              else { try { res.end() } catch { /* ignore */ } }
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/img`,
          handler: async (req, res) => {
            try {
              const q = new URL(req.url || '/', 'http://127.0.0.1')
              await pipeImage(req, res, q.searchParams.get('u') || '')
            } catch (e) {
              if (!res.headersSent) sendJson(res, 502, { ok: false, error: msgOf(e) })
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/api/health`,
          handler: async (_req, res) => {
            const out = {
              ok: true,
              official: true,
              quality: QUALITY,
              lastfm: !!lastfmKey,
              cached: urlCache.size,
              netease: null,
            }
            try {
              const t0 = Date.now()
              // 单条搜索路径会被限流；这里问的是「整体能不能搜到歌」，复用多接口兜底
              const hit = await neSearch('周杰伦', 1, 1, 0)
              out.netease = { ok: !!(hit && hit.j && hit.j.result), ms: Date.now() - t0, combo: hit ? hit.combo : null, cached: !!(hit && hit.cached) }
              out.search = searchStats()
            } catch (e) {
              out.netease = { ok: false, error: msgOf(e) }
            }
            sendJson(res, 200, out)
          },
        },
      ]

      for (const route of routes) {
        try {
          webServer.register(route)
          state.routes++
        } catch (e) {
          state.failed.push({ route: route.path, error: msgOf(e) })
        }
      }
    })
  } catch (e) {
    state.failed.push({ stage: 'inject-webServer', error: msgOf(e) })
  }

  // ── 给模型的工具 ───────────────────────────────────────────────────────
  try {
    const TEXT = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }
    ctx.tools.register({
      name: 'netease_music',
      description: '网易云音乐：搜索歌曲、看榜单、按口味推荐、查看收藏与播放历史、拿到可播放地址。播放地址只来自网易云官方接口；需要会员或受地区限制的曲目不会被解锁，resolve 会返回明确原因。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'chart', 'resolve', 'discover', 'favorites', 'history'], description: 'search=按关键词搜歌；chart=看榜单；resolve=拿播放地址；discover=按口味推荐；favorites=收藏列表；history=最近播放' },
          query: { type: 'string', description: 'search 用的关键词（歌名或歌手）' },
          id: { type: 'string', description: 'resolve 用的歌曲 id；chart 用的榜单 id（默认 3778678 热歌榜）' },
          tag: { type: 'string', description: 'discover 用的标签，例如 华语流行 / 摇滚 / 民谣 / 古风' },
          limit: { type: 'number', description: '返回条数，默认 15，最多 50' },
        },
        required: ['action'],
      },
      output: TEXT,
      execute: async (args) => {
        const action = String((args && args.action) || 'search')
        const limit = clamp(args && args.limit, 15, 1, 50)
        if (action === 'resolve') {
          const rec = await resolvePlay(args && args.id)
          return JSON.stringify({ id: rec.id, source: rec.source, official: !!rec.official, br: rec.br, size: rec.size, url: rec.url, stream: `${BASE}/stream?id=${rec.id}` }, null, 2)
        }
        if (action === 'favorites' || action === 'history') {
          const list = action === 'favorites' ? library.favorites() : library.history(limit)
          if (!list.length) return action === 'favorites' ? '还没有收藏任何歌。' : '还没有播放记录。'
          return list.slice(0, limit).map((s, i) => `${i + 1}. ${s.name}${s.artists ? ' — ' + s.artists : ''} id=${s.id}`).join('\n')
        }
        if (action === 'discover') {
          const tag = capStr(args && args.tag, 40)
          const prof = library.profile()
          const exclude = new Set([
            ...library.favorites().map((f) => f.id),
            ...library.history(30).map((h) => h.id),
            ...library.shownIds(),
          ])
          const rec = await discover({ neGet, normalize, profile: prof, tag, limit, excludeIds: [...exclude], lastfmKey, favoriteArtists: prof.favoriteArtists })
          library.markShown(rec.items.map((x) => x.id))
          const head = rec.coldStart
            ? '还没有收藏/播放数据，先给一份冷启动推荐（热门标签 + 热歌榜）：'
            : `按口味推荐（依据：收藏 ${prof.favorites.length} 首 / 播放 ${prof.totalPlays} 次${rec.seeds.artists.length ? ' / 常听 ' + rec.seeds.artists.join('、') : ''}${rec.seeds.tags.length ? ' / 标签 ' + rec.seeds.tags.join('、') : ''}）：`
          return head + '\n' + rec.items.map((s, i) => `${i + 1}. ${s.name}${s.artists ? ' — ' + s.artists : ''} id=${s.id}（${s.reason}）`).join('\n')
        }
        let songs
        let head
        if (action === 'chart') {
          const id = ((args && args.id) || '3778678').replace(/[^\d]/g, '') || '3778678'
          const j = await neGet(`/api/playlist/detail?id=${id}&n=1000`)
          const r = j && (j.result || j.playlist)
          songs = await enrichSongs((r.tracks || []).map(normalize).filter(Boolean))
          head = `榜单 ${r.name || id} 共 ${songs.length} 首：`
        } else {
          const kw = capStr(args && args.query, 60)
          if (!kw) return '请提供 query（歌名或歌手）。'
          // 别再直连 /api/search/get/web：那条路径长期 405，工具搜索会一直失败。
          // 与面板共用「域名 × 路径」矩阵 + 缓存。
          const hit = await neSearch(kw, 1, limit, 0)
          if (!hit || !hit.j) return '网易云搜索接口全部被限流了，等一两分钟再试；收藏、榜单、推荐不受影响。'
          const j = hit.j
          songs = await enrichSongs(((j && j.result && j.result.songs) || []).map(normalize).filter(Boolean))
          head = `搜索「${kw}」命中 ${(j && j.result && j.result.songCount) || songs.length} 首，前 ${songs.length} 条：`
        }
        if (!songs.length) return head + '\n（空）'
        const lines = songs.slice(0, limit).map((s, i) => `${i + 1}. ${s.name}${s.artists ? ' — ' + s.artists : ''}${s.album ? '（' + s.album + '）' : ''} id=${s.id}${s.flag ? ' [' + s.flag + ']' : ''}`)
        return head + '\n' + lines.join('\n') + `\n\n提示：要给用户播放，用 action=resolve + id 拿地址；也可以在左侧「音乐」面板里直接点播。`
      },
    })
    state.tools++
  } catch (e) {
    state.failed.push({ stage: 'tool', error: msgOf(e) })
  }

  console.log(`[dsh-music-panel] apply done: routes=${state.routes} tools=${state.tools}${state.failed.length ? ' failed=' + JSON.stringify(state.failed) : ''}`)
  trace({
    stage: 'apply-done',
    basePath: BASE,
    routes: state.routes,
    tools: state.tools,
    failed: state.failed,
  })
}

// ── 工具函数 ─────────────────────────────────────────────────────────────
function readJson(req, limitBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limitBytes) { reject(new Error('请求体过大')); try { req.destroy() } catch { /* ignore */ } ; return }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch (e) { reject(new Error('JSON 解析失败：' + msgOf(e))) }
    })
    req.on('error', reject)
  })
}

async function neGet(pathAndQuery) {
  const r = await fetch(NE + pathAndQuery, { headers: neHeaders, signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error('网易云 HTTP ' + r.status)
  const text = await r.text()
  // 网易云的 64 位 id 超出 JS 安全整数范围，先加引号再 parse，避免精度丢失
  return JSON.parse(text.replace(/([^\\]"\s*:\s*)(\d{16,})(\s*[}|,])/g, '$1"$2"$3'))
}

// 搜索接口只给 album.picId、不给 picUrl，所以补一次批量详情取封面/时长；
// 再补一次版权状态（privilege），用来在列表里标「VIP / 下架 / 试听」。
async function enrichSongs(songs) {
  const ids = songs.slice(0, 100).map((s) => s.id).filter(Boolean)
  if (!ids.length) return songs
  const param = encodeURIComponent('[' + ids.join(',') + ']')
  const [detail, priv] = await Promise.allSettled([
    neGet('/api/song/detail?ids=' + param),
    neGet('/api/song/enhance/privilege?ids=' + param),
  ])
  const dmap = new Map()
  if (detail.status === 'fulfilled') {
    for (const s of detail.value.songs || []) dmap.set(String(s.id), s)
  }
  const pmap = new Map()
  if (priv.status === 'fulfilled') {
    for (const p of priv.value.data || []) pmap.set(String(p.id), p)
  }
  return songs.map((s) => {
    const d = dmap.get(s.id)
    const p = pmap.get(s.id)
    let cover = s.cover
    let album = s.album
    let duration = s.duration
    if (d) {
      if (d.album && d.album.picUrl) cover = d.album.picUrl
      if (d.album && d.album.name) album = d.album.name
      if (d.duration) duration = d.duration
    }
    let flag = ''
    if (p) {
      if (p.st < 0) flag = '下架'
      else if (p.pl === 0) flag = 'VIP'
      else if (p.fee === 8) flag = '试听'
    }
    return {
      ...s,
      cover: cover ? cover + (cover.indexOf('?') >= 0 ? '' : '?param=200y200') : '',
      album,
      duration,
      flag,
    }
  })
}

function normalize(s) {
  if (!s || s.id == null) return null
  const rawArtists = s.artists || s.ar || []
  const artists = rawArtists.map((a) => (a && (a.name || a.nickname)) || '').filter(Boolean).join(' / ')
  // 画像要按「歌手 id」去深挖作品，所以顺手留下 id+name
  const artistList = rawArtists
    .map((a) => ({ id: String((a && (a.id || a.artistId)) || ''), name: String((a && (a.name || a.nickname)) || '') }))
    .filter((a) => a.name)
    .slice(0, 4)
  const album = s.album || s.al || {}
  let cover = album.picUrl || album.pic || ''
  if (cover.startsWith('http://')) cover = cover.replace('http://', 'https://')
  const id = String(s.id)
  return {
    id,
    name: String(s.name || s.title || '(无标题)'),
    artists,
    artistList,
    album: String(album.name || ''),
    cover,
    duration: Number(s.duration || s.dt || 0),
    fee: Number(s.fee || 0),
  }
}

// 外部输入先限长：搜索词/标签/key/文件名会成为缓存键或落盘内容，
// 不限长时一个超长参数就能把内存和 library.json 撑大。
function capStr(v, n) { return String(v == null ? '' : v).trim().slice(0, n) }

// 本地 HTTP 服务的写接口没有鉴权：任意网页可用 form POST（text/plain 绕过预检）
// 改收藏、清空搜索历史、写 Last.fm key。同源校验挡掉明确的跨站请求。
// 以 Sec-Fetch-Site 为主（Chromium/Electron 一定带），Origin 作补充；
// curl / 老客户端无这些头时放行，避免误伤本机调用。
function isCrossSite(req) {
  const h = (req && req.headers) || {}
  if (h['sec-fetch-site'] === 'cross-site') return true
  const origin = h.origin
  if (!origin || origin === 'null') return false
  try {
    const o = new URL(origin)
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false
    if (o.host === String(h.host || '')) return false
    const name = o.hostname.toLowerCase()
    if (name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1') return false
    return true
  } catch { return true }
}

// 直链来自远端接口，不能盲信：只允许 http(s) 公网地址，
// 挡掉 localhost / 127 / 10 / 172.16-31 / 192.168 / 169.254（SSRF）。
function assertPublicHttp(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('音源地址协议不允许')
  const h = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || h === '0.0.0.0') {
    throw new Error('音源地址不允许指向本机')
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const a = Number(m[1]), b = Number(m[2])
    if (a === 127 || a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      throw new Error('音源地址不允许指向内网')
    }
  }
}
function clamp(v, dflt, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.round(n)))
}

function msgOf(e) {
  if (e == null) return 'unknown error'
  if (typeof e === 'string') return e
  return String(e.message || e)
}

function homedirFallback() {
  try { return process.env.USERPROFILE || process.env.HOME || '' } catch { return '' }
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}
