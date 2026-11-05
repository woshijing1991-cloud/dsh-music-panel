// lib/recommend.js — 「猜你喜欢」的候选生成与打分
//
// 依赖的数据（都由 lib/library.js 从本机真实行为算出）：
//   · 收藏：每个收藏歌手 +3，每个标签 +2
//   · 播放历史：每次播放歌手 +1、标签 +1，按 14 天半衰期衰减；播完的 ×1.2
//
// 两个召回通道（都能解释「为什么给我这首歌」）：
//   A. 同歌手深挖：拿画像里权重最高的歌手的 artistId，走 /api/v2/artist/songs
//      把他没听过的作品捞出来（网易云对未登录搜索会压 VIP 原唱，歌手页没有这个问题）
//   B. 标签歌单：把画像里的标签（或用户点选的标签）当关键词搜歌单
//      /api/search/get/web?type=1000 → /api/playlist/detail 取曲目
//
// 打分 = 通道权重 × 画像权重 × 新鲜度，最后去重、排掉已收藏/刚听过的。

export const DISCOVER_TAGS = ['华语流行', '欧美流行', '摇滚', '民谣', '电子', '说唱', '古风', '轻音乐', '爵士', '粤语', '日语', '韩语', 'R&B', '影视原声']

const MAX_ARTIST_SEEDS = 4
const MAX_TAG_SEEDS = 3
const PER_ARTIST = 6
const PER_TAG = 8
const MAX_SIMILAR_SEEDS = 3
const PER_SIMILAR_ARTIST = 2

// Last.fm 是外部服务：超时、错 key、被限流都不能拖慢整轮推荐
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/'

export async function discover({ neGet, normalize, profile, tag, limit = 30, excludeIds = [], lastfmKey = '', fetchImpl = null, favoriteArtists = [] } = {}) {
  const exclude = new Set((excludeIds || []).map(String))
  // 收藏过 TA 的作品 = 明确的「喜欢」信号，候选分数直接 ×1.25（排序前生效）
  const favSet = new Set((favoriteArtists || []).map(String))
  const picked = []

  // 用户主动点了某个标签 → 只走标签通道
  const artistSeeds = tag ? [] : (profile.artists || []).filter((a) => a.id).slice(0, MAX_ARTIST_SEEDS)
  const tagSeeds = tag
    ? [{ tag, score: 1, count: 1 }]
    : (profile.tags || []).slice(0, MAX_TAG_SEEDS)

  const jobs = []
  for (const a of artistSeeds) {
    jobs.push(
      fetchArtistTracks(neGet, normalize, a, exclude).catch(() => []),
    )
  }
  for (const t of tagSeeds) {
    jobs.push(
      fetchTagTracks(neGet, normalize, t).catch(() => []),
    )
  }

  // 冷启动（没收藏也没历史）时给一份兜底：热门标签 + 榜单
  const coldStart = !artistSeeds.length && !tagSeeds.length
  if (coldStart) {
    for (const t of DISCOVER_TAGS.slice(0, 3)) {
      jobs.push(fetchTagTracks(neGet, normalize, { tag: t, score: 1, count: 1 }).catch(() => []))
    }
    jobs.push(fetchChartTracks(neGet, normalize).catch(() => []))
  }

  // ── C. 相似歌手（Last.fm）：只有配了 key 才走，失败一律静默降级 ──────────
  const fetchFn = fetchImpl || globalThis.fetch
  let similarSource = 'none'
  let tasteTags = []
  if (lastfmKey && !tag) {
    const seeds = (profile.artists || []).filter((a) => a.name).slice(0, MAX_SIMILAR_SEEDS)
    if (seeds.length) {
      try {
        jobs.push(fetchSimilarArtists(neGet, normalize, seeds, lastfmKey, fetchFn, exclude).then((r) => {
          similarSource = 'lastfm'
          return r
        }).catch(() => []))
        tasteTags = await collectTags(seeds, lastfmKey, fetchFn)
      } catch (e) { /* 静默降级到 A/B 通道 */ }
    }
  }

  const groups = await Promise.all(jobs)
  const viaCount = {}
  for (const g of groups) {
    for (const item of g) {
      picked.push(item)
      viaCount[item.via || '?'] = (viaCount[item.via || '?'] || 0) + 1
    }
  }

  // 去重：同一首歌只保留分最高的一条
  const byId = new Map()
  for (const item of picked) {
    if (!item || !item.song || exclude.has(item.song.id)) continue
    const prev = byId.get(item.song.id)
    if (!prev || item.score > prev.score) byId.set(item.song.id, item)
  }

  // 收藏加权：在排序**之前**改 item.score，否则排位不变、加权形同虚设。
  const FAV_BOOST = 1.25
  for (const it of byId.values()) {
    const names = (it.song.artistList || []).map((a) => String((a && a.name) || ''))
    if (!names.length) names.push(...String(it.song.artists || '').split(/\s*\/\s*/).map((n) => n.trim()))
    if (names.some((n) => n && favSet.has(n))) {
      it.score = it.score * FAV_BOOST
      it.reason = (it.reason || '') + ' · 你收藏过 TA 的作品'
    }
  }

  // 全量候选池（按分数排序）：第一页给 items，「换一批」按 offset 往后翻，
  // 这样每次点都能拿到不一样的歌，而不是被 30 分钟缓存锁死同一批。
  const pool = [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 120)
    .map((it) => ({
      ...it.song,
      reason: it.reason,
      via: it.via,
      score: Math.round(it.score * 100) / 100,
    }))
  const list = pool.slice(0, Math.max(1, Math.min(60, limit)))

  return {
    coldStart,
    stats: { via: viaCount, picked: picked.length, excluded: exclude.size, artists: artistSeeds.length, tags: tagSeeds.length },
    similarSource,
    tasteTags,
    seeds: { artists: artistSeeds.map((a) => a.name), tags: tagSeeds.map((t) => t.tag) },
    items: capSimilar(list, limit),
    pool,
  }
}

// 相似歌手负责「往外扩」，但不能把整页都占满：软上限 = limit 的 60%（至少 3 首）。
function capSimilar(list, limit) {
  const cap = Math.max(3, Math.round(limit * 0.6))
  let seen = 0
  return list.filter((it) => {
    if (it.via !== 'similar') return true
    seen += 1
    return seen <= cap
  })
}

// 歌手曲目：v2 偶尔返回 {"code":400,"msg":"参数错误"}（尤其高频请求时），v1 稳定。
// 两个都试，谁先给出 songs 用谁。
async function artistSongsOf(neGet, id, limit) {
  const eps = [
    `/api/v2/artist/songs?id=${encodeURIComponent(id)}&limit=${limit}&offset=0`,
    `/api/v1/artist/songs?id=${encodeURIComponent(id)}&limit=${limit}&offset=0`,
  ]
  for (const ep of eps) {
    try {
      const j = await neGet(ep)
      if (j && Array.isArray(j.songs) && j.songs.length) return j.songs
    } catch (e) { /* next */ }
  }
  return []
}

async function fetchArtistTracks(neGet, normalize, seed, exclude) {
  const songs = await artistSongsOf(neGet, seed.id, 100)
  const out = []
  const skip = exclude || new Set()
  // 只听这个歌手的人，前 12 首往往全在「最近播放 / 收藏」里 —— 直接 slice 会一条都剩不下。
  // 边扫边跳过已排除的，直到凑够 PER_ARTIST 首（最多扫 100 首）。
  for (let i = 0; i < songs.length && out.length < PER_ARTIST; i++) {
    const song = normalize(songs[i])
    if (!song || skip.has(song.id)) continue
    out.push({
      song,
      via: 'artist',
      score: (1 + Math.min(seed.score, 12) / 12) * (1 - i * 0.02) + 0.4,
      reason: `因为你常听 ${seed.name}`,
    })
  }
  return out
}

async function fetchTagTracks(neGet, normalize, seed) {
  // 1) 用标签搜歌单（type=1000）
  const j = await neGet(`/api/search/get/web?s=${encodeURIComponent(seed.tag)}&type=1000&limit=4`)
  const playlists = (j && j.result && j.result.playlists) || []
  const out = []
  let rank = 0
  for (const pl of playlists.slice(0, 2)) {
    let detail
    try {
      detail = await neGet(`/api/playlist/detail?id=${encodeURIComponent(pl.id)}&n=200`)
    } catch { continue }
    const r = detail && (detail.result || detail.playlist)
    const tracks = (r && r.tracks) || []
    for (const raw of tracks.slice(0, PER_TAG)) {
      const song = normalize(raw)
      if (!song) continue
      out.push({
        song,
        via: 'tag',
        score: (1 + Math.min(seed.score, 8) / 8) * 0.9 * (1 - rank * 0.01),
        reason: `标签「${seed.tag}」· 歌单《${r.name || pl.name || ''}》`,
      })
      rank++
    }
  }
  return out
}

// ── Last.fm：相似歌手 + 风格标签 ─────────────────────────────────────────
function lastfmUrl(method, params, key) {
  const q = new URLSearchParams(Object.assign({ method, api_key: key, format: 'json' }, params))
  return LASTFM_BASE + '?' + q.toString()
}

async function lastfmJson(fetchFn, url) {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(8000) })
  if (!r || !r.ok) throw new Error('lastfm http ' + (r && r.status))
  const j = await r.json()
  if (j && j.error) throw new Error('lastfm error ' + j.error)
  return j
}

async function lastfmSimilar(name, key, fetchFn) {
  const j = await lastfmJson(fetchFn, lastfmUrl('artist.getsimilar', { artist: name, limit: '8', autocorrect: '1' }, key))
  const arr = (j && j.similarartists && j.similarartists.artist) || []
  return arr
    .map((a) => ({ name: String(a.name || '').trim(), match: Number(a.match) || 0 }))
    .filter((a) => a.name)
}

async function lastfmTopTags(name, key, fetchFn) {
  const j = await lastfmJson(fetchFn, lastfmUrl('artist.gettoptags', { artist: name, autocorrect: '1' }, key))
  const arr = (j && j.toptags && j.toptags.tag) || []
  return arr.map((t) => ({ name: String(t.name || '').trim(), count: Number(t.count) || 0 })).filter((t) => t.name && t.count > 10)
}

// 歌手名 → 网易云 artistId（结果缓存在模块级 Map，避免每次推荐都搜一遍）
const artistIdCache = new Map()
// 网易云对匿名搜索有限流（实测返回 {"code":405,"msg":"操作频繁，请稍候再试"}）。
// 一旦撞上就整体冷却一段时间，别再一首歌打三次搜索把配额烧光。
let searchBlockedUntil = 0
const SEARCH_COOLDOWN_MS = 10 * 60 * 1000
function normName(x) {
  return String(x || '').toLowerCase().replace(/[\s\-_.·'"'']/g, '')
}

async function neteaseArtistId(neGet, name) {
  const key = normName(name)
  if (!key) return { id: '', name }
  if (Date.now() < searchBlockedUntil) return { id: '', name }
  const hit = artistIdCache.get(key)
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit
  try {
    // 同一个限流可能只打中某一条搜索路径，所以按顺序试三个
    let j = null
    // 注意：cloudsearch / 经典 search 没有 offset 会返回 code 400 或空结果，
    // 所以三条路径都显式带上 offset=0。
    const q = `s=${encodeURIComponent(name)}&type=100&limit=5&offset=0`
    const eps = [
      // 已知 /web 最容易被限流，放最后；前两条长期可用
      `/api/cloudsearch/pc?${q}`,
      `/api/search/get?${q}`,
      `/api/search/get/web?${q}`,
    ]
    for (const ep of eps) {
      try {
        const r = await neGet(ep)
        // 注意：cloudsearch / 经典 search 成功时也带 code: 200，!r.code 会把成功当失败
        if (r && r.result && (!r.code || r.code === 200)) { j = r; break }
      } catch (e) { /* next */ }
    }
    if (j && (j.code === 405 || j.code === 301)) {
      searchBlockedUntil = Date.now() + SEARCH_COOLDOWN_MS
      return { id: '', name }
    }
    const list = (j && j.result && j.result.artists) || []
    // Last.fm 常给繁体（林俊傑），网易云是简体（林俊杰）：精确比不中就退回搜索结果第一条，
    // 但**展示**统一用网易云解析到的这个名字，界面才不会两边对不上。
    const exact = list.find((a) => normName(a.name) === key) || list[0]
    const rec = exact
      ? { id: String(exact.id), name: String(exact.name || name), at: Date.now() }
      : { id: '', name, at: Date.now() }
    artistIdCache.set(key, rec)
    return rec
  } catch (e) {
    return { id: '', name }
  }
}

// 相似歌手通道：种子歌手 → Last.fm 相似 → 网易云歌手 → 没听过的曲目
// 打分比「同歌手」高一档：它负责把口味往邻近的歌手推，而不是原地打转。
async function fetchSimilarArtists(neGet, normalize, seeds, key, fetchFn, exclude) {
  const perSeed = await Promise.allSettled(seeds.map(async (seed) => {
    const sims = (await lastfmSimilar(seed.name, key, fetchFn)).slice(0, 4)
    const out = []
    for (const sim of sims) {
      if (sim.match && sim.match < 0.3) continue
      const hitArtist = await neteaseArtistId(neGet, sim.name)
      const id = hitArtist.id
      if (!id) continue
      // Last.fm 的 match 常被归一成 1.0（最像的那个），这种就别写「100%」，看着假
      const pct = sim.match >= 0.95 ? '' : `（${Math.round(sim.match * 100)}%）`
      let j
      const songList = await artistSongsOf(neGet, id, 30)
      if (!songList.length) continue
      j = { songs: songList }
      const songs = (j && j.songs) || []
      let picked = 0
      const skipSim = exclude || new Set()
      for (const raw of songs) {
        if (picked >= PER_SIMILAR_ARTIST) break
        const song = normalize(raw)
        if (!song || skipSim.has(song.id)) continue
        out.push({
          song,
          via: 'similar',
          score: 1.35 + (sim.match || 0.5) * 0.5,
          reason: `你常听 ${seed.name} · 相似歌手 ${hitArtist.name || sim.name}${pct}`,
        })
        picked++
      }
    }
    return out
  }))
  const flat = []
  for (const r of perSeed) if (r.status === 'fulfilled') flat.push(...r.value)
  return flat
}

async function collectTags(seeds, key, fetchFn) {
  const counts = new Map()
  const res = await Promise.allSettled(seeds.map((s) => lastfmTopTags(s.name, key, fetchFn)))
  for (const r of res) {
    if (r.status !== 'fulfilled') continue
    for (const t of r.value.slice(0, 6)) counts.set(t.name, (counts.get(t.name) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
}

async function fetchChartTracks(neGet, normalize) {
  const j = await neGet('/api/playlist/detail?id=3778678&n=60')
  const r = j && (j.result || j.playlist)
  const tracks = (r && r.tracks) || []
  return tracks.slice(0, 20).map((raw, i) => ({
    song: normalize(raw),
    via: 'chart',
    score: 1 - i * 0.01,
    reason: '热歌榜 · 先听听大家最近在放什么',
  })).filter((x) => x.song)
}
