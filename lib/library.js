// lib/library.js — 个人音乐库（收藏 / 播放历史 / 标签 / 口味画像）
//
// 为什么放宿主而不是 localStorage：
//   1. 推荐要用「收藏 + 历史 + 标签」算画像，宿主算比前端算省一次回传；
//   2. 面板要能清缓存、换浏览器都不丢；
//   3. 也方便以后给模型一个「我最近爱听什么」的工具。
//
// 存放位置：<DSH_HOME>/dsh-music-data/library.json
//   —— 刻意不放在插件目录里：profile 的 node_modules 是 pnpm 复制出来的，
//      重装/同步都可能把插件目录覆盖掉，用户数据不能跟着陪葬。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const VERSION = 1
const HISTORY_CAP = 600
const FAVORITE_CAP = 2000
const SEARCH_CAP = 12
const HALF_LIFE_DAYS = 14
// 短播放（没播完且不足 min(2 分钟, 60% 时长)）视为「不喜欢」：仍进最近播放，
// 但不计播放次数、不进口味画像。
const MIN_PLAY_MS = 120000
// 推荐过的歌 7 天内不再出现；超过 TTL 自动可再推荐，避免用久了无歌可推。
const SHOWN_TTL_MS = 7 * 86400000
const SHOWN_CAP = 400

export function createLibrary(opts = {}) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = opts.dataDir || join(dshHome, 'dsh-music-data')
  const file = join(dataDir, 'library.json')

  let db = load()
  let saveTimer = null

  function blank() {
    return { version: VERSION, favorites: [], history: [], tags: {}, plays: {}, searches: [], shown: [], updatedAt: 0 }
  }

  function load() {
    try {
      if (!existsSync(file)) return blank()
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const base = blank()
      // 逐字段兜底：手工编辑坏了也不该让插件起不来
      return {
        version: VERSION,
        favorites: Array.isArray(raw.favorites) ? raw.favorites.filter(valid) : base.favorites,
        history: Array.isArray(raw.history) ? raw.history.filter(valid) : base.history,
        tags: raw.tags && typeof raw.tags === 'object' ? raw.tags : base.tags,
        plays: raw.plays && typeof raw.plays === 'object' ? raw.plays : base.plays,
        searches: Array.isArray(raw.searches)
          ? raw.searches.filter((x) => x && typeof x.q === 'string' && x.q).slice(0, SEARCH_CAP)
          : base.searches,
        shown: Array.isArray(raw.shown)
          ? raw.shown.filter((x) => x && x.id != null).slice(0, SHOWN_CAP)
          : base.shown,
        updatedAt: Number(raw.updatedAt) || 0,
      }
    } catch {
      return blank()
    }
  }

  function saveNow() {
    try {
      mkdirSync(dataDir, { recursive: true })
      db.updatedAt = Date.now()
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
      renameSync(tmp, file) // 原子替换，断电不会留半截文件
    } catch (e) {
      console.warn('[dsh-music-panel] library save failed:', (e && e.message) || e)
    }
  }

  // 连续操作（比如批量收藏）合并写盘，避免每点一下就写文件
  function save() {
    if (saveTimer) return
    saveTimer = setTimeout(() => { saveTimer = null; saveNow() }, 400)
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    saveNow()
  }

  // ── 收藏 ──────────────────────────────────────────────────────────────
  function isFavorite(id) {
    return db.favorites.some((f) => f.id === String(id))
  }

  function toggleFavorite(song, on) {
    const id = String(song && song.id)
    if (!id) throw new Error('缺少歌曲 id')
    const has = isFavorite(id)
    const want = typeof on === 'boolean' ? on : !has
    if (want && !has) {
      db.favorites.unshift({ ...compact(song), addedAt: Date.now() })
      if (db.favorites.length > FAVORITE_CAP) db.favorites.length = FAVORITE_CAP
      save()
    } else if (!want && has) {
      db.favorites = db.favorites.filter((f) => f.id !== id)
      save()
    }
    return { ok: true, favorite: want, count: db.favorites.length }
  }

  function favorites() {
    return db.favorites.slice()
  }

  // ── 播放历史 ──────────────────────────────────────────────────────────
  function isSkipped(playedMs, completed, duration) {
    const ms = Math.max(0, Number(playedMs) || 0)
    const threshold = duration > 0 ? Math.min(MIN_PLAY_MS, duration * 0.6) : MIN_PLAY_MS
    return !completed && ms < threshold
  }

  function recordPlay(song, meta = {}) {
    const id = String(song && song.id)
    if (!id) throw new Error('缺少歌曲 id')
    const at = Date.now()
    const playedMs = Math.max(0, Number(meta.playedMs) || 0)
    const completed = !!meta.completed
    const duration = Number(song && song.duration) || 0
    const skipped = isSkipped(playedMs, completed, duration)
    const last = db.history[0]
    // 同一首歌 30 秒内重复上报（暂停/继续、拖动进度）只更新最后一条
    if (last && last.id === id && at - last.at < 30000) {
      const wasSkipped = !!last.skipped
      last.at = at
      last.playedMs = Math.max(last.playedMs || 0, playedMs)
      last.completed = last.completed || completed
      last.skipped = !!last.skipped && skipped   // 只要有一次够长/播完就不算跳过
      if (wasSkipped && !last.skipped) db.plays[id] = (db.plays[id] || 0) + 1
    } else {
      db.history.unshift({ ...compact(song), at, playedMs, completed, skipped })
      if (db.history.length > HISTORY_CAP) db.history.length = HISTORY_CAP
      if (!skipped) db.plays[id] = (db.plays[id] || 0) + 1
    }
    save()
    return { ok: true, count: db.history.length, skipped }
  }

  function history(limit = 100) {
    return db.history.slice(0, Math.max(1, Math.min(600, limit)))
  }

  // ── 标签 ──────────────────────────────────────────────────────────────
  function setTags(id, tags) {
    const key = String(id || '').slice(0, 32)
    if (!key) throw new Error('缺少歌曲 id')
    const list = (Array.isArray(tags) ? tags : String(tags || '').split(/[,，\s]+/))
      .map((t) => String(t).trim())
      .filter(Boolean)
      .slice(0, 8)
    if (list.length) db.tags[key] = Array.from(new Set(list))
    else delete db.tags[key]
    save()
    return { ok: true, id: key, tags: db.tags[key] || [] }
  }

  // ── 搜索历史 ──────────────────────────────────────────────────────────
  // 只留最近 12 条；同一个词再搜一次不新增，而是提到最前并累加次数。
  function addSearch(q) {
    const kw = String(q || '').trim().slice(0, 60)
    if (!kw) return searches()
    const key = kw.toLowerCase()
    const hit = db.searches.find((x) => String(x.q).toLowerCase() === key)
    if (hit) {
      hit.at = Date.now()
      hit.count = (Number(hit.count) || 1) + 1
      db.searches = [hit, ...db.searches.filter((x) => x !== hit)]
    } else {
      db.searches.unshift({ q: kw, at: Date.now(), count: 1 })
      if (db.searches.length > SEARCH_CAP) db.searches.length = SEARCH_CAP
    }
    save()
    return searches()
  }

  function searches() {
    return db.searches.slice()
  }

  function clearSearches() {
    db.searches = []
    save()
    return []
  }

  function tagsOf(id) {
    return db.tags[String(id)] || []
  }

  // ── 推荐曝光记录 ──────────────────────────────────────────────────────
  // 只记「实际返回给前端」的那批，不是整个候选池；7 天后自动失效。
  function shownIds() {
    const cutoff = Date.now() - SHOWN_TTL_MS
    return db.shown.filter((x) => (Number(x.at) || 0) >= cutoff).map((x) => String(x.id))
  }

  function markShown(ids) {
    const at = Date.now()
    const seen = new Set(db.shown.map((x) => String(x.id)))
    for (const raw of (Array.isArray(ids) ? ids : [])) {
      const id = String(raw == null ? '' : (raw.id != null ? raw.id : raw))
      if (!id) continue
      const hit = db.shown.find((x) => String(x.id) === id)
      if (hit) hit.at = at
      else if (!seen.has(id)) db.shown.unshift({ id, at })
      seen.add(id)
    }
    if (db.shown.length > SHOWN_CAP) db.shown.length = SHOWN_CAP
    save()
    return shownIds().length
  }

  function clearShown() {
    db.shown = []
    save()
    return 0
  }

  // ── 口味画像 ──────────────────────────────────────────────────────────
  // 依据（全部是本机真实产生的数据）：
  //   收藏  → 歌手 +5、标签 +3（收藏是明确的「喜欢」，权重高于一次播放）
  //   播放  → 歌手 +1、标签 +1，按 14 天半衰期衰减；播完 ×1.2
  //   跳过  → 不足 min(2 分钟, 60% 时长) 且未播完：不参与画像
  const W_FAV_ARTIST = 5
  const W_FAV_TAG = 3
  function profile() {
    const artistScore = new Map() // name -> { score, id, count }
    const tagScore = new Map()
    const now = Date.now()
    const decay = (at) => Math.pow(0.5, Math.max(0, now - (Number(at) || now)) / (HALF_LIFE_DAYS * 86400000))

    const bump = (map, key, amount, extra) => {
      if (!key) return
      const cur = map.get(key) || { score: 0, count: 0, ...extra }
      cur.score += amount
      cur.count += 1
      if (extra && extra.id && !cur.id) cur.id = extra.id
      map.set(key, cur)
    }

    for (const f of db.favorites) {
      for (const a of artistPairs(f)) bump(artistScore, a.name, W_FAV_ARTIST, { id: a.id })
      for (const t of tagsOf(f.id)) bump(tagScore, t, W_FAV_TAG)
    }
    for (const h of db.history) {
      if (h.skipped) continue
      const w = decay(h.at) * (h.completed ? 1.2 : 1)
      for (const a of artistPairs(h)) bump(artistScore, a.name, w, { id: a.id })
      for (const t of tagsOf(h.id)) bump(tagScore, t, w)
    }

    const artists = [...artistScore.entries()]
      .map(([name, v]) => ({ name, id: v.id || '', score: round(v.score), count: v.count }))
      .sort((a, b) => b.score - a.score)
    const tags = [...tagScore.entries()]
      .map(([tag, v]) => ({ tag, score: round(v.score), count: v.count }))
      .sort((a, b) => b.score - a.score)

    const totalPlays = Object.values(db.plays).reduce((s, n) => s + (Number(n) || 0), 0)
    // 收藏歌曲的歌手名集合：推荐打分时对这些歌手的候选额外 ×1.25
    const favoriteArtists = [...new Set(db.favorites.flatMap((f) => artistPairs(f).map((a) => a.name)))].filter(Boolean)
    return {
      artists: artists.slice(0, 12),
      tags: tags.slice(0, 12),
      favoriteArtists,
      totalPlays,
      favorites: db.favorites.length,
      history: db.history.length,
      // 依据说明，直接给面板展示
      basis: {
        favorites: db.favorites.length,
        plays: totalPlays,
        taggedSongs: Object.keys(db.tags).length,
        decayHalfLifeDays: HALF_LIFE_DAYS,
        weights: { favoriteArtist: W_FAV_ARTIST, favoriteTag: W_FAV_TAG, playArtist: 1, playTag: 1, completedBonus: 1.2, favoriteBoost: 1.25 },
        minPlayMs: MIN_PLAY_MS,
        shownTtlDays: SHOWN_TTL_MS / 86400000,
        skippedCount: db.history.filter((h) => h.skipped).length,
        shownCount: shownIds().length,
      },
    }
  }

  function snapshot() {
    return {
      favorites: db.favorites.slice(),
      history: db.history.slice(0, 120),
      plays: { ...db.plays },
      tags: { ...db.tags },
      searches: db.searches.slice(),
      profile: profile(),
      file,
    }
  }

  return { file, isFavorite, toggleFavorite, favorites, recordPlay, history, setTags, tagsOf, addSearch, searches, clearSearches, shownIds, markShown, clearShown, profile, snapshot, flush }
}

// ── 小工具 ───────────────────────────────────────────────────────────────
function valid(x) {
  return x && typeof x === 'object' && x.id != null && String(x.id).length > 0
}

function cap(v, n) { return String(v == null ? '' : v).slice(0, n) }

function compact(song) {
  return {
    id: cap(song.id, 32),
    name: cap(song.name || '(无标题)', 200),
    artists: cap(song.artists || '', 200),
    artistList: Array.isArray(song.artistList)
      ? song.artistList.slice(0, 4).map((a) => ({ id: cap(a && a.id, 32), name: cap(a && a.name, 100) }))
      : [],
    album: cap(song.album || '', 200),
    cover: cap(song.cover || '', 512),
    duration: Number(song.duration || 0),
    flag: cap(song.flag || '', 20),
  }
}

function artistPairs(song) {
  const out = []
  if (Array.isArray(song.artistList)) {
    for (const a of song.artistList) if (a && a.name) out.push({ id: String(a.id || ''), name: String(a.name) })
  }
  if (!out.length && song.artists) {
    for (const n of String(song.artists).split(/\s*\/\s*/)) if (n.trim()) out.push({ id: '', name: n.trim() })
  }
  return out
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}
