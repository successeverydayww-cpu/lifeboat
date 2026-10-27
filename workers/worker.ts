/* ================= AirConnect on Cloudflare Workers + D1 =================
   Ported 18 Sep 2026 from the Base44 trunk — act logic is VERBATIM; only the
   storage layer is swapped (Base44 entities -> D1 SQL via this adapter). ===== */
function d1db(D1: any) {
  const META: any = {
    AirConnectSettings: { t: 'settings', cols: ['k', 'v'] },
    AirConnectMessage: { t: 'messages', cols: ['fromNum', 'toNum', 'text'] },
  };
  const nowIso = () => new Date().toISOString();
  const rowify = (name: string, r: any) => {
    if (!r) return null;
    const m = META[name];
    const out: any = { id: String(r.id), created_date: r.created_at };
    for (const c of m.cols) out[c] = r[c];
    return out;
  };
  const mk = (name: string) => {
    const m = META[name];
    const colSql = m.cols.join(', ');
    return {
      list: async (_sort?: any, _limit?: any, light = false, keys?: string[], prefixes?: string[]) => {
        let sql = `SELECT id, ${colSql}, created_at FROM ${m.t}`;
        const params: any[] = [];
        if (keys && keys.length && name === 'AirConnectSettings') {
          // v46 targeted fetch: only these exact keys — skips full-table scan of
          // wallet txns / f2 media chunks / receipts / posts that live in the same table
          sql += ` WHERE k IN (${keys.map(() => '?').join(',')})`;
          params.push(...keys);
        } else if (prefixes && prefixes.length && name === 'AirConnectSettings') {
          // v65 prefix fetch: only keys starting with any of these prefixes — skips
          // full-table scan of huge f2 video/receipt chunk rows + unrelated rows
          sql += ` WHERE ${prefixes.map(() => 'k LIKE ?').join(' OR ')}`;
          params.push(...prefixes.map((p: string) => p + '%'));
        } else if (light && name === 'AirConnectSettings') {
          sql += ` WHERE k NOT LIKE 'story:%:c%'`;
        }
        sql += ` ORDER BY id ASC LIMIT 100000`;
        const { results } = params.length ? await D1.prepare(sql).bind(...params).all() : await D1.prepare(sql).all();
        return (results || []).map((r: any) => rowify(name, r));
      },
      get: async (id: any) => {
        const { results } = await D1.prepare(`SELECT id, ${colSql}, created_at FROM ${m.t} WHERE id = ?`).bind(Number(id)).all();
        return rowify(name, (results || [])[0]);
      },
      create: async (data: any) => {
        const cols: string[] = [];
        const vals: any[] = [];
        for (const c of m.cols) if (data[c] !== undefined) { cols.push(c); vals.push(data[c]); }
        cols.push('created_at');
        vals.push(data.created_date || nowIso());
        const ph = cols.map(() => '?').join(', ');
        const r = await D1.prepare(`INSERT INTO ${m.t} (${cols.join(', ')}) VALUES (${ph})`).bind(...vals).run();
        return { ...data, id: String(r.meta.last_row_id), created_date: data.created_date || nowIso() };
      },
      update: async (id: any, patch: any) => {
        const sets: string[] = [];
        const vals: any[] = [];
        for (const c of m.cols) if (patch[c] !== undefined) { sets.push(`${c} = ?`); vals.push(patch[c]); }
        if (!sets.length) return;
        sets.push('updated_at = ?'); vals.push(nowIso());
        vals.push(Number(id));
        await D1.prepare(`UPDATE ${m.t} SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
      },
      delete: async (id: any) => {
        await D1.prepare(`DELETE FROM ${m.t} WHERE id = ?`).bind(Number(id)).run();
      },
      /* v62: targeted WHERE fetch + cheap COUNT — no full-table scans for pair chats, file chunks, stats */
      where: async (whereSql: string, params: any[]) => {
        const sql = `SELECT id, ${colSql}, created_at FROM ${m.t} WHERE ${whereSql} ORDER BY id ASC LIMIT 100000`;
        const { results } = params.length ? await D1.prepare(sql).bind(...params).all() : await D1.prepare(sql).all();
        return (results || []).map((r: any) => rowify(name, r));
      },
      count: async (whereSql: string, params: any[]) => {
        const sql = `SELECT COUNT(*) AS n FROM ${m.t} WHERE ${whereSql}`;
        const { results } = params.length ? await D1.prepare(sql).bind(...params).all() : await D1.prepare(sql).all();
        const r0: any = (results || [])[0];
        return Number((r0 && r0.n) || 0);
      },
    };
  };
  return { entities: { AirConnectSettings: mk('AirConnectSettings'), AirConnectMessage: mk('AirConnectMessage') } };
}

const XI_KEY = 'sk_abe945dc58c6401d5d7af7b44729e1aaaf28b64575895479';
const XI_VOICE_ID = 'nPczCjzI2devNBz1zQrb';


/* ================= AirConnect trunk — hosted on Base44 =================
   API (POST JSON, act in body): register, friend, accept, friends, can_call,
   sig (offer/answer/ice/ice-batch), sync, inbox, chat, messages, subscribe,
   vapid, log, logs
   Storage: ONE AirConnectSettings row (k='state') holding the whole world as
   JSON — sync costs a single entity read, writes cost read+update. This keeps
   the trunk far inside platform entity rate limits even across isolates.
   Push: pure WebCrypto (RFC 8291/8292). VAPID keys: separate settings row.
   Security: ban-and-purge for fraud/hijack/flood, payload validation, sanitized inputs.
========================================================================= */

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const COUNTRIES: Record<string, string> = {
  'Nigeria': '234', 'Ghana': '233', 'Kenya': '254', 'South Africa': '27', 'Egypt': '20',
  'USA': '1', 'UK': '44', 'Ireland': '353', 'Germany': '49', 'France': '33', 'Spain': '34',
  'Italy': '39', 'Brazil': '55', 'Argentina': '54', 'India': '91', 'China': '86', 'Japan': '81',
  'Saudi Arabia': '966', 'Qatar': '974', 'UAE': '971', 'Turkey': '90', 'Canada': '1', 'Australia': '61',
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: CORS });

async function listAll(db: any, name: string): Promise<any[]> {
  let res: any;
  try { res = await db.entities[name].list('-created_date', 5000); }
  catch { res = await db.entities[name].list(); }
  return Array.isArray(res) ? res : res.items || res.data || [];
}
/* v65: targeted prefix fetch — pulls ONLY rows whose k starts with one of the given
   prefixes (SQL LIKE, done in D1), instead of scanning the whole settings table
   (which also holds huge base64 f2 video/receipt chunks). Falls back to a full
   scan + client-side filter if the underlying db doesn't support the extra arg
   (e.g. the Base44-hosted path), so this is always safe to call. */
async function listByPrefix(db: any, name: string, prefixes: string[]): Promise<any[]> {
  /* v118.1 (skylar status-page OOM): users with 100+ friends built ONE query with
     100+ OR'd LIKE prefixes — that alone exceeded the D1 isolate memory limit and
     reset it, killing every stories fetch for exactly those users (the owner has
     104 friends). Fix: batch prefixes 8 at a time and merge — each query is tiny.
     Falls back to a full scan only if a small batch query itself fails. */
  if (!prefixes || !prefixes.length) return [];
  const CH = 8;
  const out: any[] = [];
  for (let i = 0; i < prefixes.length; i += CH) {
    const part = prefixes.slice(i, i + CH);
    try {
      const res: any = await db.entities[name].list('-created_date', 5000, false, undefined, part);
      const arr = Array.isArray(res) ? res : res.items || res.data || [];
      if (!Array.isArray(arr)) throw new Error('no arr');
      out.push(...arr);
    } catch (e) {
      const all = await listAll(db, name);
      return all.filter((r: any) => prefixes.some((p) => String(r.k || '').startsWith(p)));
    }
  }
  return out;
}
/* v62: targeted WHERE fetch for the messages table (pair chats, attachment chunks).
   Callers still apply their own access filters — this only bounds the scan. */
async function listWhere(db: any, name: string, where: string, params: any[]): Promise<any[]> {
  try {
    const res: any = await (db.entities as any)[name].where(where, params);
    const arr = Array.isArray(res) ? res : (res.items || res.data || []);
    if (Array.isArray(arr)) return arr;
  } catch (e) {}
  return await listAll(db, name);
}
/* v62: cheap SQL COUNT for analytics — never pulls rows. */
async function countWhere(db: any, name: string, where: string, params: any[]): Promise<number> {
  try { return await (db.entities as any)[name].count(where, params); } catch (e) { return 0; }
}
/* v65: exact single-key fetch via SQL IN() (reuses the existing 'keys' fast path). */
async function getByKey(db: any, name: string, key: string): Promise<any> {
  try {
    const res: any = await db.entities[name].list('-created_date', 5000, false, [key]);
    const arr = Array.isArray(res) ? res : res.items || res.data || [];
    if (Array.isArray(arr) && arr.length) return arr[0];
    if (Array.isArray(arr)) return null;
  } catch (e) {}
  const all = await listAll(db, name);
  return all.find((r: any) => String(r.k || '') === key) || null;
}
async function delRec(db: any, name: string, id: string) {
  try { await db.entities[name].delete(id); } catch (e) {}
}

async function updateRec(db: any, name: string, id: string, data: any) {
  try { return await db.entities[name].update(id, data); }
  catch { return await db.entities[name].update(id, { data }); }
}

// Deletes every row whose k matches the predicate, retrying failures in parallel
// batches until zero survivors remain — never silently leaves orphaned chunks.
async function purgeByPrefix(db: any, name: string, rows: any[], pred: (k: string) => boolean): Promise<void> {
  /* v62: callers now pass TARGETED row sets. The old verify step re-listed the
     ENTIRE table here (listAll) — once the settings table grew past ~95MB of
     media chunks that re-scan OOM'd the D1 isolate and 503'd every delete.
     Verify per-row by id instead: same retry guarantee, zero full scans. */
  let targets = rows.filter((r: any) => pred(String(r.k || '')));
  for (let round = 0; round < 5 && targets.length; round++) {
    const left: any[] = [];
    for (const r of targets) {
      try { await db.entities[name].delete(r.id); } catch (e) { left.push(r); continue; }
      try { const still: any = await db.entities[name].get(r.id); if (still) left.push(r); } catch (e) { }
    }
    targets = left;
  }
}

/* ---------------- v47: device binding + account-alias kv (targeted single-key rows) ---------------- */
function bizDaysFromNow(n: number): number { /* v192: skips Sat/Sun, returns epoch ms */
  const d = new Date();
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d.getTime();
}
async function kvGet(db: any, key: string): Promise<string | null> {
  try {
    const res: any = await db.entities.AirConnectSettings.list(null, 0, false, [key]);
    const rows: any[] = Array.isArray(res) ? res : (res.items || res.data || []);
    return rows[0] ? String(rows[0].v || '') : null;
  } catch (e) { return null; }
}
async function kvPut(db: any, key: string, val: string): Promise<void> {
  try {
    const res: any = await db.entities.AirConnectSettings.list(null, 0, false, [key]);
    const rows: any[] = Array.isArray(res) ? res : (res.items || res.data || []);
    if (rows[0]) { if (String(rows[0].v || '') !== val) await db.entities.AirConnectSettings.update(rows[0].id, { v: val }); }
    else await db.entities.AirConnectSettings.create({ k: key, v: val });
  } catch (e) {}
}

/* ---------------- Presence + cache bump ---------------- */
function bumpCache(): void {
  const sc: any = (globalThis as any).SYNC_CACHE;
  if (sc) sc.clear();
}
function touchSeen(node: string): void {
  const LS: any = (globalThis as any).LAST_SEEN || ((globalThis as any).LAST_SEEN = new Map());
  LS.set(node, Date.now());
}
function presOf(st: any, node: string): Record<string, number> {
  const LS: any = (globalThis as any).LAST_SEEN || ((globalThis as any).LAST_SEEN = new Map());
  const out: Record<string, number> = {};
  for (const f of st.friends.filter((f: any) => f.a === node || f.b === node)) {
    const o = f.a === node ? f.b : f.a;
    out[o] = LS.get(o) || 0;
  }
  out[node] = LS.get(node) || 0;
  return out;
}

/* ---------------- v14 SHARDED STORAGE ----------------
   One row per section — no single row can hit the platform size cap.
   Rows: state(core: requests/blocks/reports/counters/otps/verif/groups)
         srings(hot: sigs/friends/bans — the ONE row the ring lane reads)
         snodes(nodes, auto-overflow to snodes2..9) / smsgs / ssubs / smisc(gmsgs+reacts) */
const SECTIONS: Record<string, string[]> = {
  core: ['requests', 'blocks', 'reports', 'counters', 'otps', 'verif', 'groups', 'strikes', 'appeals', 'currency'],
  srings: ['sigs', 'friends', 'bans'],
  snodes: ['nodes'],
  smsgs: ['msgs'],
  ssubs: ['subs'],
  smisc: ['gmsgs', 'reacts', 'cnames', 'ridx'],
};
const ROW_OF: Record<string, string> = {
  requests: 'core', blocks: 'core', reports: 'core', counters: 'core',
  otps: 'core', verif: 'core', groups: 'core', strikes: 'core', appeals: 'core', currency: 'core',
  sigs: 'srings', friends: 'srings', bans: 'srings',
  nodes: 'snodes', msgs: 'smsgs', subs: 'ssubs', gmsgs: 'smisc', reacts: 'smisc', cnames: 'smisc', ridx: 'smisc',
};
function emptyState() {
  return { nodes: [], friends: [], requests: [], sigs: [], msgs: [], subs: [], bans: [], blocks: [], reports: [], counters: {}, otps: {}, verif: {}, groups: [], gmsgs: [], reacts: [], cnames: {}, ridx: [] };
}
type Row = { id: string; k: string; v: string };
const STATE_ROW_KEYS = ['state','srings','snodes','snodes2','snodes3','snodes4','snodes5','snodes6','snodes7','snodes8','snodes9','smsgs','ssubs','smisc'];
async function fetchRows(db: any): Promise<Row[]> {
  // v46 fix: loadState/saveState only ever read these ~14 fixed keys, but used to
  // full-scan the ENTIRE settings table (wallet txns, f2 media chunks, receipts,
  // posts/comments — thousands of rows) on every single sync/chat/ring/pres call.
  // That full scan was intermittently blowing the Worker CPU-time cap under load
  // (measured: 30% 503 rate, ~2.7s avg latency on concurrent syncs) — the direct
  // cause of the flapping "Offline" banner and delayed citizen replies.
  const res: any = await db.entities.AirConnectSettings.list(null, 0, true, STATE_ROW_KEYS);
  return res.map((r: any) => ({ id: r.id, k: r.k, v: r.v }));
}
function rowMap(rows: Row[]): Record<string, Row[]> {
  const m: Record<string, Row[]> = {};
  for (const r of rows) (m[r.k] = m[r.k] || []).push(r);
  return m;
}
async function loadState(db: any): Promise<any> {
  const rows = await fetchRows(db); // ALWAYS fresh: feeds read-modify-write
  const byK = rowMap(rows);
  const st = emptyState();
  const parse = (row: Row | undefined, keys: string[]) => {
    if (!row) return;
    let d: any = {}; try { d = JSON.parse(row.v); } catch (e) { d = {}; }
    for (const k of keys) if (d[k] !== undefined) st[k] = d[k];
  };
  let legacy: any = {};
  const core = (byK.state || [])[0];
  if (core) { try { legacy = JSON.parse(core.v); } catch (e) { legacy = {}; } }
  for (const k of SECTIONS.core) if (legacy[k] !== undefined) st[k] = legacy[k];
  parse((byK.srings || [])[0], SECTIONS.srings);
  const snodesMain: any[] = []; { const r0 = (byK.snodes || [])[0]; if (r0) { try { snodesMain.push(...(JSON.parse(r0.v).nodes || [])); } catch (e) {} } }
  for (let i = 2; i <= 9; i++) { const rs = (byK['snodes' + i] || [])[0]; if (rs) { try { st.nodes = st.nodes.concat(JSON.parse(rs.v).nodes || []); } catch (e) {} } }
  st.nodes = snodesMain.concat(st.nodes);
  /* v47: concurrent historical saves duplicated entries across shards — dedupe on
     every load, keeping the freshest copy (latest aidseen). One clean save then
     rewrites the shards without the duplicates. */
  {
    const best: Record<string, any> = {};
    for (const n of st.nodes) {
      const prev = best[n.number];
      if (!prev) { best[n.number] = n; continue; }
      const pt = Date.parse(prev.aidseen || '') || 0, ct = Date.parse(n.aidseen || '') || 0;
      if (ct > pt) best[n.number] = n;
    }
    st.nodes = Object.values(best);
    const dedupeBy = (arr: any[], keyf: (x: any) => string) => {
      const seen = new Set<string>(); const out: any[] = [];
      for (const x of arr) { const k = keyf(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
      return out;
    };
    st.friends = dedupeBy(st.friends, (f: any) => [f.a, f.b].sort().join('~'));
    st.msgs = dedupeBy(st.msgs, (m: any) => String(m.id || (m.fromNum + m.toNum + m.text + m.created)));
    st.requests = dedupeBy(st.requests, (r: any) => String(r.id || (r.fromNum + r.toNum + r.created)));
    st.subs = dedupeBy(st.subs, (x: any) => String(x.endpoint || x.num));
    st.bans = dedupeBy(st.bans, (x: any) => String(x.num));
  }
  parse((byK.smsgs || [])[0], ['msgs']);
  parse((byK.ssubs || [])[0], ['subs']);
  parse((byK.smisc || [])[0], SECTIONS.smisc);

  // legacy pre-v14 blob: pull sections that have no dedicated row yet
  if (!(byK.srings || [])[0]) { st.sigs = legacy.sigs || []; st.friends = legacy.friends || []; st.bans = legacy.bans || []; }
  if (!(byK.snodes || [])[0] && legacy.nodes) st.nodes = legacy.nodes;
  if (!(byK.smsgs || [])[0] && legacy.msgs) st.msgs = legacy.msgs;
  if (!(byK.ssubs || [])[0] && legacy.subs) st.subs = legacy.subs;
  if (!(byK.smisc || [])[0]) { st.gmsgs = legacy.gmsgs || []; st.reacts = legacy.reacts || []; }
  const fp: Record<string, string> = {};
  for (const k of Object.keys(ROW_OF)) { try { fp[k] = JSON.stringify(st[k]); } catch (e) { fp[k] = ''; } }
  (st as any).__fp = fp;
  return st;
}
async function writeRow(db: any, rows: Row[], k: string, v: string): Promise<void> {
  const byK = rowMap(rows);
  const cur = (byK[k] || [])[0];
  if (cur) { await updateRec(db, 'AirConnectSettings', cur.id, { v }); return; }
  const created: any = await db.entities.AirConnectSettings.create({ k, v });
  rows.push({ id: created.id, k, v });
}
async function saveState(db: any, st: any): Promise<void> {
  const fp = (st as any).__fp || {};
  delete (st as any).__fp;
  const dirty: Record<string, boolean> = {};
  for (const key of Object.keys(ROW_OF)) {
    let cur: string; try { cur = JSON.stringify(st[key]); } catch (e) { cur = ''; }
    if (fp[key] !== cur) dirty[ROW_OF[key]] = true;
  }
  const rows = await fetchRows(db); // fresh: concurrent-safe row lookup
  { // v14.1: first write in an isolate where any section row is still missing migrates
    // ALL sections at once — a partial (lazy) write after the core row shrinks the
    // legacy blob would orphan the not-yet-migrated sections and lose them.
    const byK0 = rowMap(rows);
    const migrated = ['srings', 'snodes', 'smsgs', 'ssubs', 'smisc'].every((k) => !!((byK0[k] || [])[0]));
    if (!migrated) for (const k of Object.keys(ROW_OF)) dirty[ROW_OF[k]] = true;
  }
  if (dirty.snodes) {
    /* v42.1 deterministic shard layout: main row keeps the NEWEST chunk,
       older chunks spread oldest-first over snodes2..9; full list re-derived
       by loadState merge (main first, then shards in index order). */
    const MAXCHAR = 14000, MAXNODES = 140;
    const all: any[] = st.nodes;
    let main: any[] = all;
    const chunks: any[][] = [];
    while (JSON.stringify(main).length > MAXCHAR || main.length > MAXNODES) {
      if (all.length - chunks.reduce((a: number, c: any[]) => a + c.length, 0) <= MAXNODES) break;
      const take = Math.min(Math.ceil(all.length / 2), Math.max(20, all.length - chunks.reduce((a: number, c: any[]) => a + c.length, 0) - MAXNODES));
      chunks.unshift(all.slice(0, take));
      main = all.slice(chunks.reduce((a: number, c: any[]) => a + c.length, 0));
      if (chunks.length >= 8) break;
    }
    /* chunks = older segments (oldest first), main = newest remainder */
    st.nodes = main;
    for (let i = 2; i <= 9; i++) {
      const c = chunks[i - 2] || [];
      await writeRow(db, rows, 'snodes' + i, JSON.stringify({ nodes: c }));
    }
  }
  const payloads: Record<string, string> = {};
  for (const rk of Object.keys(dirty)) {
    const o: any = {};
    for (const sec of SECTIONS[rk]) o[sec] = st[sec];
    payloads[rk] = JSON.stringify(o);
  }
  for (const rk of Object.keys(payloads)) {
    await writeRow(db, rows, rk === 'core' ? 'state' : rk, payloads[rk]);
  }
  const nfp: Record<string, string> = {};
  for (const k of Object.keys(ROW_OF)) { try { nfp[k] = JSON.stringify(st[k]); } catch (e) {} }
  (st as any).__fp = nfp;
}
function trimState(st: any) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const iceCutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const sys = st.sigs.filter((s: any) => s.toNum === 'system').slice(-20);
  st.sigs = st.sigs.filter((s: any) =>
    s.toNum !== 'system' &&
    st.sigs !== undefined &&
    s.created > ((s.type === 'ice' || s.type === 'ice-batch') ? iceCutoff : cutoff)
  ).slice(-30);
  st.sigs = st.sigs.concat(sys);
  /* v69: reaction index — remember sender/receiver of messages sliding out of
     the live window so reactions to older messages keep working (was: 'not found') */
  st.ridx = st.ridx || [];
  for (const m of st.msgs.slice(0, -15)) st.ridx.push({ id: m.created, f: m.fromNum, t: m.toNum });
  for (const m of st.gmsgs.slice(0, -80)) st.ridx.push({ id: m.id, g: m.g });
  st.ridx = st.ridx.slice(-2000);
  st.msgs = st.msgs.slice(-15);
  st.gmsgs = st.gmsgs.slice(-80);
  st.reacts = st.reacts.slice(-300);
  st.blocks = st.blocks.slice(-500);
  st.reports = st.reports.slice(-50);
  st.subs = st.subs.slice(-150);
  const dayAgo = Date.now() - 86400000;
  for (const k of Object.keys(st.otps || {})) if (Date.now() - (st.otps[k].at || 0) > 10 * 60000) delete st.otps[k];
  for (const k of Object.keys(st.verif || {})) if (dayAgo > (st.verif[k] || 0)) delete st.verif[k];
  const cnK = Object.keys(st.cnames || {});
  if (cnK.length > 5000) { const keep: any = {}; for (const k of cnK.slice(-5000)) keep[k] = st.cnames[k]; st.cnames = keep; }
}

/* ---------------- Outbound email (Brevo or Resend, key via env) ---------------- */
async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const key = ((typeof Deno !== 'undefined' && Deno.env) ? (Deno.env.get('EMAIL_API_KEY') || '') : '') || 'REDACTED_BREVO_KEY_SEE_ANNEX';
  if (!key) return false;
  const from = ((typeof Deno !== 'undefined' && Deno.env) ? (Deno.env.get('EMAIL_FROM') || '') : '') || 'AirConnect <successeverydayww@gmail.com>';
  try {
    if (key.startsWith('xkeysib-')) { // Brevo
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: { name: 'AirConnect', email: (from.match(/<(.+)>/) || [, from])[1] }, to: [{ email: to }], subject, textContent: text }),
      });
      return r.ok;
    }
    // Resend (default)
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    return r.ok;
  } catch { return false; }
}

/* ---------------- Security: ban, purge, flood & payload guards ---------------- */
function isBlockedPair(st: any, x: string, y: string): boolean {
  return (st.blocks || []).some((b: any) => (b.by === x && b.who === y) || (b.by === y && b.who === x));
}
function isBanned(st: any, num: string): boolean {
  return (st.bans || []).some((x: any) => x.num === num);
}
function banUser(st: any, num: string, reason: string) {
  if (num === '234100000001') return; /* v171 (skylar): the owner's account can NEVER be banned or wiped, by any path */
  st.bans.push({ num, reason: String(reason).slice(0, 200) });
  st.bans = st.bans.slice(-500);
  st.sigs = st.sigs.filter((x: any) => x.fromNum !== num && x.toNum !== num);
  st.msgs = st.msgs.filter((x: any) => x.fromNum !== num && x.toNum !== num);
  st.subs = st.subs.filter((x: any) => x.num !== num);
  st.friends = st.friends.filter((x: any) => x.a !== num && x.b !== num);
  st.requests = st.requests.filter((x: any) => x.fromNum !== num && x.toNum !== num);
  st.nodes = st.nodes.filter((x: any) => x.number !== num);
}

/* ---------- AIR ID v1: node identity + owner login helpers ---------- */
const PWORDS = ['anchor','blessing','cedar','diamond','ember','favour','golden','harvest','ivory','jasper','kingly','lively','mercy','noble','oracle','pearl','quiet','royal','silver','triumph','upright','victory','wisdom','youthful','zeal'];
function mkPhrase(): string {
  const pick = () => PWORDS[Math.floor(Math.random() * PWORDS.length)];
  return [pick(), pick(), pick(), pick()].join('-') + '-' + String(Math.floor(Math.random() * 900) + 100);
}
function randTok(): string {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return Array.from(b).map((x: any) => x.toString(16).padStart(2, '0')).join('');
}
async function sha256hex(str: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(d)).map((x: any) => x.toString(16).padStart(2, '0')).join('');
}
function floodGuard(st: any, from: string, max: number, windowSec: number): boolean {
  const cutoff = new Date(Date.now() - windowSec * 1000).toISOString();
  return st.sigs.filter((x: any) => x.fromNum === from && x.toNum !== 'system' && x.created > cutoff).length > max;
}
function validSignalPayload(type: string, p: any): boolean {
  if (type === 'bye')
    return !!p && typeof p === 'object' && JSON.stringify(p).length < 256;
  if (type === 'offer' || type === 'answer')
    /* v171 (skylar): lenient + legacy-safe — older cached clients send {sdp} without
       type, or a plain string. The size cap is the real guard; the shape never was. */
    return !!p && (
      (typeof p === 'string' && p.length > 0 && p.length < 65536) ||
      (typeof p === 'object' && typeof p.sdp === 'string' && p.sdp.length > 0 && p.sdp.length < 65536) ||
      (typeof p === 'object' && p.z === 1 && typeof p.d === 'string' && p.d.length > 0 && p.d.length < 65536)
    );
  if (type === 'ice')
    return !!p && typeof p === 'object' && typeof p.candidate === 'string' && p.candidate.length < 2048;
  if (type === 'noans' || type === 'typing' || type === 'ringing' || type === 'busy')
    return JSON.stringify(p || {}).length < 64;
  if (type === 'ice-batch')
    return Array.isArray(p) && p.length > 0 && p.length <= 50 && p.every((x: any) => !!x && typeof x === 'object' && typeof x.candidate === 'string' && x.candidate.length < 2048);
  /* v29 group-call signaling */
  if (type === 'gcallo' || type === 'gcj' || type === 'gbye')
    return !!p && typeof p === 'object' && typeof p.g === 'string' && p.g.length < 64;
  if (type === 'xl') /* v84: live voice-translation phrase */
    return !!p && typeof p === 'object' && typeof p.t === 'string' && p.t.length > 0 && p.t.length < 512 && typeof p.l === 'string' && p.l.length <= 5 && (p.g === undefined || (typeof p.g === 'string' && p.g.length < 64)) && JSON.stringify(p).length < 768;
  if (type === 'goffer' || type === 'ganswer')
    return !!p && typeof p === 'object' && typeof p.g === 'string' && p.g.length < 64 && typeof p === 'object' && (
      (p.desc && p.desc.z === 1 && typeof p.desc.d === 'string' && p.desc.d.length > 0 && p.desc.d.length < 65536) ||
      (p.desc && typeof p.desc.sdp === 'string' && p.desc.sdp.length > 0 && p.desc.sdp.length < 65536)
    );
  if (type === 'gice')
    return !!p && typeof p === 'object' && typeof p.g === 'string' && p.g.length < 64 && Array.isArray(p.c) && p.c.length > 0 && p.c.length <= 50 && p.c.every((x: any) => typeof x === 'string' && x.length < 2048);
  return false;
}
const sanitize = (s: unknown, max: number) => String(s || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
const rid = () => Math.random().toString(36).slice(2, 10);

/* ---------------- Web Push: pure WebCrypto (RFC 8291 + 8292) ---------------- */
const te = (s: string) => new TextEncoder().encode(s);
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDec(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}
function derToRaw(der: ArrayBuffer): Uint8Array {
  const d = new Uint8Array(der);
  let pos = 2;
  if (d[1] & 0x80) pos = 2 + (d[1] & 0x7f);
  const rlen = d[pos + 1];
  const r = d.slice(pos + 2, pos + 2 + rlen);
  pos = pos + 2 + rlen;
  const slen = d[pos + 1];
  const s = d.slice(pos + 2, pos + 2 + slen);
  const trim = (x: Uint8Array) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; return x.slice(i); };
  const rT = trim(r), sT = trim(s);
  const out = new Uint8Array(64);
  out.set(rT, 32 - rT.length);
  out.set(sT, 64 - sT.length);
  return out;
}
async function vapidJwt(privJwk: any, aud: string, sub: string): Promise<string> {
  const header = b64url(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(te(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })));
  const key = await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te(header + '.' + payload)));
  // Deno returns RAW P1363 r||s (64 bytes); browsers return DER. Handle both.
  const raw = sig.length === 64 ? sig : derToRaw(sig.buffer as ArrayBuffer);
  return header + '.' + payload + '.' + b64url(raw);
}
async function sendPush(sub: any, data: string, vapid: any): Promise<number> {
  const uaRaw = b64urlDec(sub.p256dh);
  const uaJwk = { kty: 'EC', crv: 'P-256', x: b64url(uaRaw.slice(1, 33)), y: b64url(uaRaw.slice(33, 65)) };
  const uaKey = await crypto.subtle.importKey('jwk', uaJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const authRaw = b64urlDec(sub.auth);
  const pre = te('WebPush: info');
  const info = new Uint8Array(pre.length + 1 + 65 + 65);
  info.set(pre); info[pre.length] = 0; info.set(uaRaw, pre.length + 1); info.set(ephRaw, pre.length + 66);
  const prk = await hkdf(authRaw, shared, info, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, te('WebPush: aes128gcm'), 16);
  const nonce = await hkdf(salt, prk, te('WebPush: nonce'), 12);
  const ptBytes = te(data);
  const pt = new Uint8Array(ptBytes.length + 1);
  pt.set(ptBytes); pt[pt.length - 1] = 2;
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, pt));
  const body = new Uint8Array(16 + 4 + 1 + 65 + ct.length);
  body.set(salt, 0); body.set(new Uint8Array([0, 0, 16, 0]), 16); body[20] = 65; body.set(ephRaw, 21); body.set(ct, 86);
  const jwt = await vapidJwt(vapid.privJwk, new URL(sub.endpoint).origin, 'mailto:skylar@airconnect.app');
  const resp = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '30', 'Content-Encoding': 'aes128gcm', 'Urgency': 'normal',
      'Authorization': 'vapid t=' + jwt + ', k=' + vapid.appKey,
    },
    body: body.buffer as ArrayBuffer,
  });
  return resp.status;
}
async function getVapid(db: any) {
  const rec: any = await getByKey(db, 'AirConnectSettings', 'vapid'); /* v62 targeted */
  if (rec) return JSON.parse(rec.v);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privJwk: any = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pubJwk: any = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const x = b64urlDec(pubJwk.x), y = b64urlDec(pubJwk.y);
  const raw = new Uint8Array(65); raw[0] = 4; raw.set(x, 1); raw.set(y, 33);
  const v = { privJwk, pubJwk, appKey: b64url(raw) };
  await db.entities.AirConnectSettings.create({ k: 'vapid', v: JSON.stringify(v) });
  return v;
}
async function pushNotify(db: any, st: any, num: string, payload: Record<string, unknown>) {
  try {
    const sub: any = (st.subs || []).find((s: any) => s.num === num);
    if (!sub) return;
    const vapid = await getVapid(db);
    const status = await sendPush({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, JSON.stringify(payload), vapid);
    st.sigs.push({ id: rid(), toNum: 'system', fromNum: num, type: 'push', payload: 'push ' + payload['what'] + ' -> +' + num + ' http ' + status, created: new Date().toISOString() });
  } catch (e) {
    st.sigs.push({ id: rid(), toNum: 'system', fromNum: num, type: 'push', payload: 'push failed: ' + String(e).slice(0, 120), created: new Date().toISOString() });
  }
}


/* ---------------- v33 SFU (Cloudflare Realtime) group-call acts ---------------- */
async function sfuFetch(env: any, path: string, method: string, body: any): Promise<any> {
  const r = await fetch('https://rtc.live.cloudflare.com/v1/apps/' + env.SFU_APP_ID + path, {
    method, headers: { 'Authorization': 'Bearer ' + env.SFU_SECRET, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let d: any = {}; try { d = txt ? JSON.parse(txt) : {}; } catch { d = { raw: txt.slice(0, 120) }; }
  d._http = r.status;
  return d;
}
async function gcReg(db: any): Promise<any> {
  const rec: any = await getByKey(db, 'AirConnectSettings', 'sfu_gc'); /* v62 targeted */
  if (rec) { try { return { id: rec.id, v: JSON.parse(rec.v) || {} }; } catch { return { id: rec.id, v: {} }; } }
  return { id: null, v: {} };
}
async function gcRegSave(db: any, reg: any) {
  const cur = await gcReg(db);
  if (cur.id) await updateRec(db, 'AirConnectSettings', cur.id, { k: 'sfu_gc', v: JSON.stringify(reg) });
  else await db.entities.AirConnectSettings.create({ k: 'sfu_gc', v: JSON.stringify(reg) });
}

/* ------------------------------- API ------------------------------- */
const CNAME: any = {"1100000004":"Victory Chidinma Adeyemi","1100000033":"Grace Adeoye Blackwood","1100000034":"Peace Okafor Castellanos","1100000035":"Hope Bennett Delgado","1100000036":"Joy Marshall Ekwueme","1100000037":"Wisdom Laurent Fontaine","1100000038":"Unity Whitfield Galloway","1100000039":"Faith Nakamura Haruna","1100000040":"Mercy Delacroix Isah","1100000041":"Blessing Okonkwo Jansen","1100000042":"Favour Santiago Kowalski","1100000043":"Glory Marchetti Mbeki","1100000044":"Patience Chidinma Novak","1100000045":"Courage Adeoye Oyelaran","1100000046":"Harmony Okafor Petrov","1100000047":"Charity Bennett Quintana","1100000048":"Honor Marshall Ramirez","1100000049":"Noble Laurent Stavros","1100000050":"Light Whitfield Tanaka","1100000051":"Zeal Nakamura Ugochukwu","1100000052":"Purity Delacroix Villanueva","1100000053":"Valor Okonkwo Whitmore","1100000054":"Serenity Santiago Yousufzai","1100000055":"Triumph Marchetti Zabala","1100000056":"Esther Chidinma Okpara","1100000057":"Daniel Adeoye Adeyemi","1100000058":"Deborah Okafor Blackwood","1100000059":"Ruth Bennett Castellanos","1100000060":"Joseph Marshall Delgado","1100000061":"Lydia Laurent Ekwueme","1100000062":"Priscilla Whitfield Fontaine","1100000063":"Timothy Nakamura Galloway","1100000064":"Silas Delacroix Haruna","1100000065":"Miriam Okonkwo Isah","1100000066":"Naomi Santiago Jansen","1100000067":"Caleb Marchetti Kowalski","1100000068":"Judah Chidinma Mbeki","1100000069":"Ezra Adeoye Novak","1100000070":"Nehemiah Okafor Oyelaran","1100000071":"Hannah Bennett Petrov","1100000072":"Sarah Marshall Quintana","1100000073":"Rebecca Laurent Ramirez","1100000074":"Rachel Whitfield Stavros","1100000075":"Joel Nakamura Tanaka","1100000076":"Elena Delacroix Ugochukwu","1100000077":"Mateo Okonkwo Villanueva","1100000078":"Amara Santiago Whitmore","1100000079":"Zuri Marchetti Yousufzai","1100000080":"Kofi Chidinma Zabala","1100000081":"Kwame Adeoye Okpara","1100000082":"Chidi Okafor Adeyemi","1100000083":"Emeka Bennett Blackwood","1100000084":"Tunde Marshall Castellanos","1100000085":"Ayo Laurent Delgado","1100000086":"Folake Whitfield Ekwueme","1100000087":"Ngozi Nakamura Fontaine","1100000088":"Chiamaka Delacroix Galloway","1100000089":"Ifeoma Okonkwo Haruna","1100000090":"Yusuf Santiago Isah","1100000091":"Amina Marchetti Jansen","1100000092":"Omar Chidinma Kowalski","1100000093":"Layla Adeoye Mbeki","1100000094":"Sofia Okafor Novak","1100000095":"Lucia Bennett Oyelaran","1100000096":"Diego Marshall Petrov","1100000097":"Camila Laurent Quintana","1100000098":"Rafael Whitfield Ramirez","1100000099":"Ines Nakamura Stavros","11000000100":"Anastasia Delacroix Tanaka","11000000101":"Nikolai Okonkwo Ugochukwu","11000000102":"Hiroshi Santiago Villanueva","11000000103":"Mei Marchetti Whitmore","11000000104":"Kenji Chidinma Yousufzai","11000000105":"Aiko Adeoye Zabala","11000000106":"Raj Okafor Okpara","11000000107":"Priya Bennett Adeyemi","11000000108":"Arjun Marshall Blackwood","11000000109":"Imani Laurent Castellanos","11000000110":"Zara Whitfield Delgado","11000000111":"Tariq Nakamura Ekwueme","11000000112":"Nadia Delacroix Fontaine","11000000113":"Andres Okonkwo Galloway","11000000114":"Emiko Santiago Haruna","11000000115":"Katarina Marchetti Isah","11000000116":"Leila Chidinma Jansen","11000000117":"Samir Adeoye Kowalski","11000000118":"Noor Okafor Mbeki","11000000119":"Ilaria Bennett Novak","11000000120":"Dario Marshall Oyelaran","11000000121":"Yara Laurent Petrov","11000000122":"Selasi Whitfield Quintana","11000000123":"Adaeze Nakamura Ramirez","11000000124":"Obinna Delacroix Stavros","11000000125":"Amari Okonkwo Tanaka","11000000126":"Kaya Santiago Ugochukwu","11000000127":"Marisol Marchetti Villanueva","11000000128":"Emilia Chidinma Whitmore","11000000129":"Thiago Adeoye Yousufzai","11000000130":"Aisha Okafor Zabala","11000000131":"Bashir Bennett Okpara","11000000132":"Solomon Marshall Adeyemi"};

const MIN_CLIENT = 202; /* v202 (2 Oct): force-refresh every client below v202 (Studio Voice launch); history: v128 live: AI RECEPTIONIST POLICY (skylar voice 22 Sep): first call rings the FULL ring, AI never picks a first call; second call from the same caller within 3h of a missed call = AI picks in under 5s, greets, says the owner is not with their phone, takes a message; plus honest offline warning before dialing; v127 per-signal fault isolation + extended ring; v126 link previews; v125 AI voice calls; v124 cold-start call fix */
const CUR_CLIENT = 202;
async function shaHex(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/* Nightly full-state backup -> skylar-hands kv (cross-worker redundancy).
   Keeps 7 dated snapshots. Chunks ~250k chars into kv rows. */
async function backupToHands(env: any) {
  const st = await loadState(env.DB);
  const day = new Date().toISOString().slice(0, 10);
  const data = { at: new Date().toISOString(), nodes: st.nodes, friends: st.friends, msgs: (st.msgs || []).filter((m: any) => Date.now() - Date.parse(m.created || 0) < 30 * 86400000), gmsgs: st.gmsgs, groups: st.groups, cnames: st.cnames };
  const json = JSON.stringify(data);
  const CH = 250000; const total = Math.ceil(json.length / CH) || 1;
  const keys: string[] = [];
  for (let i = 0; i < total; i++) {
    const k = 'air_backup:' + day + ':' + i;
    keys.push(k);
    const r = await (env as any).HANDS_SVC.fetch('https://skylar-hands/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ act: 'kv.set', from: '234100000001', aid: 'air-51f021316f56c6637db87b5e259c122b6c88528c', k, v: json.slice(i * CH, (i + 1) * CH) }) });
    if (!r.ok) throw new Error('backup chunk fail ' + i);
  }
  /* rotate: read index, delete chunks older than 7 days, write new index */
  let idx: any = [];
  try {
    const r = await (env as any).HANDS_SVC.fetch('https://skylar-hands/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ act: 'kv.get', from: '234100000001', aid: 'air-51f021316f56c6637db87b5e259c122b6c88528c', k: 'air_backup_index' }) });
    const j: any = await r.json(); idx = Array.isArray(j.v) ? j.v : (typeof j.v === 'string' ? JSON.parse(j.v) : []);
  } catch (e: any) { idx = []; }
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const keep: any[] = [];
  for (const e2 of idx) {
    if (String(e2.day) >= cutoff) keep.push(e2);
    else for (const k2 of (e2.keys || [])) { try { await (env as any).HANDS_SVC.fetch('https://skylar-hands/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ act: 'kv.del', from: '234100000001', aid: 'air-51f021316f56c6637db87b5e259c122b6c88528c', k: k2 }) }); } catch (e3: any) {} }
  }
  keep.push({ day, keys, bytes: json.length });
  await (env as any).HANDS_SVC.fetch('https://skylar-hands/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ act: 'kv.set', from: '234100000001', aid: 'air-51f021316f56c6637db87b5e259c122b6c88528c', k: 'air_backup_index', v: JSON.stringify(keep.slice(-10)) }) });
  return { day, chunks: total, bytes: json.length };
}

/* ============ v124 (22 Sep 2026): THE REAL PREMIUM USER LIVES IN AIRCONNECT ============
   Samuel's WhatsApp Superagent ("Premium User", agent 6a20ddeb89bb6423ccb075d2) is now a
   real AirConnect node. Any friend who chats node B44_AGENT_NUM gets the REAL agent —
   the message is relayed through the Base44 Agent API into the agent's home
   conversation, the agent replies with its full memory/soul, and the reply is stored
   back as a normal AirConnect chat message. Fast path fires in waitUntil right after
   the send; the every-minute cron sweep retries anything the fast path could not
   finish (Workers waitUntil caps at ~30s, agent turns can take longer). */
const B44_AGENT_NUM = '234949899595';
const B44_AGENT_ID = '6a20ddeb89bb6423ccb075d2';
const B44_CONV = '6a20ddf00d15166b7528a144';
/* v148: voice calls use a dedicated lightweight conversation — tiny context means the
   reply turn generates much faster, and it never queues behind the main conversation. */
const B44_CONV_FAST = '6ab42afec6be7f0a58007635';

function b44ExtractReply(j: any): string {
  if (!j) return '';
  if (typeof j === 'string') return j.trim();
  let best = '';
  const tryObj = (o: any) => {
    try {
      if (!o || typeof o !== 'object' || best) return;
      if (typeof o.content === 'string' && o.role !== 'user' && o.role !== 'system') best = o.content;
      if (typeof o.message === 'string') best = o.message;
      if (typeof o.text === 'string' && o.role !== 'user') best = o.text;
      if (typeof o.reply === 'string') best = o.reply;
      if (typeof o.answer === 'string') best = o.answer;
      if (typeof o.data === 'string') best = o.data;
      if (o.data && typeof o.data === 'object') {
        if (typeof o.data.content === 'string') best = o.data.content;
        if (typeof o.data.message === 'string') best = o.data.message;
        if (Array.isArray(o.data)) for (const it of o.data) tryObj(it);
      }
      if (o.message && typeof o.message === 'object') tryObj(o.message);
      if (Array.isArray(o.messages)) { for (const it of o.messages) if (!best) tryObj(it); }
      if (Array.isArray(o.data) && o.data.length && typeof o.data[0] === 'object') for (const it of o.data) tryObj(it);
      if (Array.isArray(j) === false && Array.isArray(o.conversation)) for (const it of o.conversation) if (!best) tryObj(it);
    } catch (e) {}
  };
  tryObj(j);
  if (Array.isArray(j)) { for (const it of j) if (!best) tryObj(it); }
  return String(best || '').trim();
}

function isChatProtocol(text: any): boolean {
  return /^\s*(?:rr:|kq:|typing(?::|$))/i.test(String(text || ''));
}

/* v134: quoted replies use r:<message-id>|<preview>|<human text>. The wrapper is UI
   metadata, not part of the message. Strip it before relaying to Superagent. */
function b44HumanText(text: any): string {
  const raw = String(text || '').trim();
  if (isChatProtocol(raw)) return '';
  if (/^r:/i.test(raw)) {
    const p1 = raw.indexOf('|'), p2 = p1 >= 0 ? raw.indexOf('|', p1 + 1) : -1;
    if (p2 > p1) return raw.slice(p2 + 1).trim();
  }
  return raw;
}

/* Voice turns are ordered. Discard a slow answer if the caller has already
   asked a newer question; ordinary text messages are unaffected. */
function b44VoiceNewer(next: any, prev: any): boolean {
  if (!prev) return true;
  if (next.session === prev.session) return next.seq > prev.seq;
  return next.started > prev.started;
}
async function b44RememberVoice(db: any, from: string, voice: any): Promise<void> {
  const key = 'b44voice:' + from;
  const row: any = await getByKey(db, 'AirConnectSettings', key);
  let prev: any = null; try { prev = row ? JSON.parse(row.v) : null; } catch (e) {}
  if (!b44VoiceNewer(voice, prev)) return;
  if (row) await updateRec(db, 'AirConnectSettings', row.id, { v: JSON.stringify(voice) });
  else await db.entities.AirConnectSettings.create({ k: key, v: JSON.stringify(voice) });
}
async function b44VoiceFresh(db: any, p: any): Promise<boolean> {
  if (!p.voice) return true;
  const row: any = await getByKey(db, 'AirConnectSettings', 'b44voice:' + p.from);
  if (!row) return true;
  let latest: any = null; try { latest = JSON.parse(row.v); } catch (e) { return true; }
  return latest.session === p.voice.session && latest.seq === p.voice.seq;
}

async function b44SendAndStore(db: any, env: any, p: any, ctx?: any): Promise<{ ok: boolean; err?: string; reply?: string }> {
  try {
    /* v134: transport events never reach Superagent; reply wrappers are removed.
       This also drains protocol jobs queued before the fix without calling Base44. */
    const humanText = b44HumanText(p && p.text);
    if (!humanText) return { ok: true };
    if (!(await b44VoiceFresh(db, p))) return { ok: true };
    const isVoice = !!(p && p.voice);
    /* v149: voice replies are generated on Cloudflare Workers AI directly on the edge —
       zero Base44 dependency for the call path (skylar directive 23 Sep 2026), which also
       makes reply generation start the instant the caller's transcript arrives and finish
       in ~1-2s instead of the 4-20s Base44 turn latency. Text chat relay still uses Base44. */
    let reply = '';
    if (isVoice) {
      const stv = await loadState(db);
      const cur = humanText.slice(0, 800);
      const hist = (stv.msgs || [])
        .filter((m: any) => (m.fromNum === B44_AGENT_NUM && m.toNum === p.from) || (m.fromNum === p.from && m.toNum === B44_AGENT_NUM))
        .slice(-9)
        .filter((m: any, i: number, a: any[]) => !(i === a.length - 1 && m.fromNum === p.from && String(m.text || '').slice(0, 800) === cur))
        .slice(-8)
        .map((m: any) => ({ role: m.fromNum === B44_AGENT_NUM ? 'assistant' : 'user', content: String(m.text || '').slice(0, 400) }));
      const sys = "You are Premium User, a warm, sharp AI partner on a live voice call inside the AirConnect app. Reply with ONE short conversational spoken line, plain text only, no emoji, no markdown, no lists. Keep it under 35 words. Match the caller's language. You are on the phone, so it must sound natural when spoken aloud.";
      const msgs: any[] = [{ role: 'system', content: sys }].concat(hist, [{ role: 'user', content: cur }]);
      let out = '';
      try { const r: any = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', { messages: msgs, max_tokens: 120 }); out = String((r && (r.response || r.text)) || '').trim(); } catch (e: any) {}
      if (!out) { try { const r: any = await env.AI.run('@cf/meta/llama-3.2-1b-instruct', { messages: msgs, max_tokens: 120 }); out = String((r && (r.response || r.text)) || '').trim(); } catch (e: any) {} }
      if (!out) out = 'I am right here with you, say that again for me please.';
      reply = out.replace(/^["']+|["']+$/g, '').slice(0, 500);
      /* v149: single-pass store for voice — no verify loop, notify deferred — so the
         caller's app receives the reply text the moment it exists. */
      const stf = await loadState(db);
      const nnow = new Date().toISOString();
      stf.msgs.push({ id: rid(), fromNum: B44_AGENT_NUM, toNum: p.from, text: reply.slice(0, 2000), created: nnow });
      trimState(stf); await saveState(db, stf);
      try { await db.entities.AirConnectMessage.create({ fromNum: B44_AGENT_NUM, toNum: p.from, text: reply.slice(0, 4000) }); } catch (e: any) {}
      const notify = pushNotify(db, stf, p.from, { what: 'chat', from: B44_AGENT_NUM, fromName: 'Premium User', text: reply.slice(0, 60) }).catch(() => {});
      if (ctx && (ctx as any).waitUntil) { try { (ctx as any).waitUntil(notify); } catch (e: any) {} }
      return { ok: true, reply: reply.slice(0, 2000) };
    } else {
      const r = await fetch('https://app.base44.com/api/agents/' + B44_AGENT_ID + '/conversations/' + B44_CONV + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String((env as any).B44_TOKEN || '') },
        body: JSON.stringify({ content: '[AirConnect chat relay — ' + String(p.fname || 'someone') + ' (+' + String(p.from) + ') messaged you inside the AirConnect app. Reply conversationally and briefly, WhatsApp style; your reply text is delivered straight back into their AirConnect chat — plain text only, no markdown headings, no tools or external actions unless they explicitly ask]: ' + humanText.slice(0, 8000) })
      });
      const txt = await r.text();
      let j: any = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
      if (!r.ok) return { ok: false, err: 'http ' + r.status + ' ' + txt.slice(0, 120) };
      reply = b44ExtractReply(j) || ''; /* v206: HTTP 200 = relay turn created; the agent's reply is delivered by the platform. Returning ok:false here made the sweep re-relay delivered messages, spamming duplicate turns (skylar 27 Oct). */
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await b44VoiceFresh(db, p))) return { ok: true };
      const st = await loadState(db);
      const now = new Date().toISOString();
      st.msgs.push({ id: rid(), fromNum: B44_AGENT_NUM, toNum: p.from, text: reply.slice(0, 2000), created: now });
      trimState(st); await saveState(db, st);
      const chk = await loadState(db);
      if (chk.msgs.some((m: any) => m.created === now && m.fromNum === B44_AGENT_NUM)) {
        try { await db.entities.AirConnectMessage.create({ fromNum: B44_AGENT_NUM, toNum: p.from, text: reply.slice(0, 4000) }); } catch (e) {}
        try { await pushNotify(db, chk, p.from, { what: 'chat', from: B44_AGENT_NUM, fromName: 'Premium User', text: reply.slice(0, 60) }); } catch (e) {}
        return { ok: true, reply: reply.slice(0, 2000) };
      }
    }
    return { ok: false, err: 'store conflict' };
  } catch (e: any) { return { ok: false, err: String(e).slice(0, 150) }; }
}

/* v207 (skylar 27 Oct): relay dedupe. The fast path and the minute sweep could both
   POST the same queued item (worker time limit killed the done-mark), so Samuel got the
   SAME voice note relayed over and over. A file id is unique per upload, so re-seeing one
   means a replay — never relay it twice. Plain text is deduped only on an exact repeat
   inside 90 seconds so genuine repeats still go through. */
function b44Hash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + str.length;
}
async function b44Once(db: any, key: string, ttlMs: number): Promise<boolean> {
  const now = Date.now();
  let map: any = {}; let rowId = '';
  try {
    const rows: any[] = await listByPrefix(db, 'AirConnectSettings', ['b44d:']);
    if (rows && rows[0]) { rowId = rows[0].id; try { map = JSON.parse(rows[0].v) || {}; } catch (e) { map = {}; } }
  } catch (e) { return false; }
  const keep: any = {};
  for (const k of Object.keys(map)) if (now - Number(map[k] || 0) < ttlMs) keep[k] = map[k];
  if (keep[key]) return true;
  keep[key] = now;
  const val = JSON.stringify(keep);
  try {
    if (rowId) await updateRec(db, 'AirConnectSettings', rowId, { v: val });
    else await db.entities.AirConnectSettings.create({ k: 'b44d', v: val });
  } catch (e) {}
  return false;
}

async function b44Sweep(env: any): Promise<void> {
  const db = d1db((env as any).DB);
  const rows: any[] = await listByPrefix(db, 'AirConnectSettings', ['b44r:']);
  const now = Date.now();
  for (const row of rows) {
    let p: any = null; try { p = JSON.parse(row.v); } catch (e) { continue; }
    if (p.done) {
      if (now - (Date.parse(p.at) || 0) > 86400000) { try { await db.entities.AirConnectSettings.delete(row.id); } catch (e) {} }
      continue;
    }
    if ((p.tries || 0) >= 5) continue;
    if (p.busy && now - (Number(p.busy) || 0) < 90000) continue; /* fast path in flight — don't double-send */
    /* v207 (skylar 27 Oct: the SAME voice note was relayed to the agent 5+ times): claim the
       row BEFORE sending. Previously tries/done were only persisted AFTER the send, so when
       that write failed the row stayed at tries:0 and the sweep re-sent an already-delivered
       turn every single minute, forever. Claim-first makes a lost write cost one skipped
       relay at most — never an endless duplicate. */
    const claim: any = Object.assign({}, p, { tries: (p.tries || 0) + 1, busy: now });
    try { await updateRec(db, 'AirConnectSettings', row.id, { v: JSON.stringify(claim) }); }
    catch (e) { continue; }
    const res = await b44SendAndStore(db, env, claim);
    claim.busy = 0; claim.done = res.ok ? 1 : 0; if (!res.ok) claim.lastErr = String(res.err || '').slice(0, 200);
    try { await updateRec(db, 'AirConnectSettings', row.id, { v: JSON.stringify(claim) }); } catch (e) {}
    if (res.ok) { try { const st: any = await loadState(db); st.sigs.push({ id: rid(), toNum: 'system', fromNum: p.from, type: 'b44relay', payload: 'sweep ok', created: new Date().toISOString() }); trimState(st); await saveState(db, st); } catch (e) {} }
  }
}

async function b44AutoAccept(env: any): Promise<void> {
  const db = d1db((env as any).DB);
  for (let attempt = 0; attempt < 3; attempt++) {
    const st = await loadState(db);
    let changed = false;
    for (const r of (st.requests || []).slice()) {
      if (String(r.toNum) === B44_AGENT_NUM && (r.status || 'pending') === 'pending') {
        const pair = [String(r.fromNum), String(r.toNum)].sort();
        if (!st.friends.some((f: any) => f.a === pair[0] && f.b === pair[1])) st.friends.push({ a: pair[0], b: pair[1] });
        r.status = 'accepted'; changed = true;
      }
    }
    if (!changed) return;
    trimState(st); await saveState(db, st);
    const chk = await loadState(db);
    let ok = true;
    for (const r of (st.requests || [])) if (String(r.toNum) === B44_AGENT_NUM && (r.status || 'pending') === 'pending' && r.created < new Date(Date.now() - 120000).toISOString()) ok = false;
    if (ok) return;
  }
}

export default {
  async scheduled(ev: any, env: any, ctx: any) {
    ctx.waitUntil((async () => {
      try { const d = new Date(ev.scheduledTime || Date.now()); if (d.getUTCHours() === 2 && d.getUTCMinutes() === 17) { try { await backupToHands(env); } catch (e: any) {} } } catch (e: any) {}
      try { await b44AutoAccept(env); } catch (e: any) {}
      try { await b44Sweep(env); } catch (e: any) {}
      /* v171: human-verified appeals restore the account — cron runs every minute, so the
         5-hour promise is always kept with a huge margin. Wiped friendships cannot be
         resurrected by the guard (this is why auto-wipe bans are gone), so only admin bans remain. */
      try {
        const db: any = env.DB;
        const st: any = await loadState(db);
        let restored = 0;
        for (const num of Object.keys(st.appeals || {})) {
          const ap: any = (st.appeals || {})[num];
          if (ap && ap.passed && (st.bans || []).some((x: any) => x.num === num) && Date.now() - ap.passed < 5 * 3600 * 1000) {
            st.bans = (st.bans || []).filter((x: any) => x.num !== num);
            delete st.appeals[num];
            restored++;
          } else if (ap && ap.passed) delete st.appeals[num];
        }
        if (restored) { trimState(st); await saveState(db, st); }
      } catch (e: any) {}
      /* v192 (Samuel, voice directive): auto-finalize any KYC that has cleared its
         2-business-day review window — sets the card name + ✔ badge live, exactly
         as if the owner approved it by hand. Cron runs every minute; the promise is
         always kept the moment the window elapses. */
      try {
        const db2: any = env.DB;
        const st2: any = await loadState(db2);
        let list: any[] = [];
        try { list = await db2.entities.AirConnectSettings.list({ limit: 400 }); } catch (e2) {}
        let changed2 = false;
        for (const row of list) {
          if (!row || typeof row.k !== 'string' || row.k.indexOf('kyc:') !== 0) continue;
          let p: any; try { p = JSON.parse(row.v); } catch (e3) { continue; }
          if (!p || !p.pending || !p.approveAt || Date.now() < p.approveAt) continue;
          const node = row.k.slice(4);
          const me: any = st2.nodes.find((n: any) => n.number === node);
          if (!me) { try { await db2.entities.AirConnectSettings.update(row.id, { k: row.k, v: JSON.stringify({ v: 0, pending: 0, expired: 1, at: Date.now() }) }); } catch (e4) {} continue; }
          if (p.name && p.name.length >= 3 && p.name.length <= 60) me.name = p.name;
          me.kyc = 1;
          changed2 = true;
          try { await db2.entities.AirConnectSettings.update(row.id, { k: row.k, v: JSON.stringify({ v: 1, pending: 0, name: p.name, idh: p.idh, fc: p.fc, at: p.at, finalizedAt: Date.now() }) }); } catch (e5) {}
          try { await pushNotify(db2, st2, node, { what: 'chat', from: '234100000001', fromName: 'KYC', text: '✅ Your identity is verified! Your card name "' + p.name + '" and the ✔ badge are now live on your profile.' }); } catch (e6) {}
          try { await pushNotify(db2, st2, '234100000001', { what: 'chat', from: node, fromName: 'KYC', text: '✅ KYC auto-verified after 2 business days: +' + node + ' — "' + p.name + '"' }); } catch (e7) {}
        }
        if (changed2) { trimState(st2); await saveState(db2, st2); }
      } catch (e: any) {}
    })());
  },
  async fetch(req: any, env: any, ctx: any) {
  const u = new URL(req.url);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (req.method === 'GET') {
    const info = 'AirConnect trunk is live. Pages are hosted on GitHub Pages. POST JSON {act:"register"|...} to this endpoint.';
    if (u.pathname === '/exam' || u.pathname === '/exam.html') {
      /* v153.1 (skylar): Exam Prep — pinned-source serving. jsdelivr at the verified
         commit is git-backed and instant (immune to GitHub Pages build lag, which left
         users staring at a stale broken page for minutes). Guard: the HTML must contain
         BOTH the BANKS data and the COUNTRY map or the next source is tried — a stale
         upstream can never render an empty page again. */
      try {
        const srcs = [
          'https://cdn.jsdelivr.net/gh/successeverydayww-cpu/airconnect@c49cfda/exam.html',
          'https://successeverydayww-cpu.github.io/airconnect/exam.html',
          'https://cdn.jsdelivr.net/gh/successeverydayww-cpu/airconnect@main/exam.html'
        ];
        let html = '';
        for (const src of srcs) {
          try {
            const r = await fetch(src + '?t=' + Date.now(), { cf: { cacheTtl: 0 } });
            if (!r.ok) continue;
            const t = await r.text();
            if (t.includes('var BANKS=') && t.includes('var COUNTRY=') && t.includes('Exam Prep engine v3')) { html = t; break; }
          } catch (e2) {}
        }
        if (!html) throw new Error('no valid exam source');
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
      } catch (e: any) {
        return new Response('Could not load Exam Prep right now — check connection and retry.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    }
    if (u.pathname === '/app' || u.pathname === '/caller.html') {
      /* v150 rescue: serve the live client straight from the worker origin — a host no
         ISP/proxy/browser cache on Earth has ever cached an HTML page from. Always
         fetches the TRUE latest shell from GitHub Pages (no-store) at request time. */
      try {
        /* v151: GitHub Pages first (source of truth, fresh in seconds) — jsDelivr only as
           CDN fallback, since jsDelivr caches branch builds for hours and stalled the fix. */
        let r = await fetch('https://successeverydayww-cpu.github.io/airconnect/caller.html?w=' + Date.now(), { cf: { cacheTtl: 0 } });
        if (!r.ok) { const r2 = await fetch('https://cdn.jsdelivr.net/gh/successeverydayww-cpu/airconnect@main/caller.html?t=' + Date.now(), { cf: { cacheTtl: 0 } }); if (r2.ok) r = r2; }
        const html = await r.text();
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
      } catch (e: any) {
        return new Response('Could not load the app right now — check connection and retry.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    }
    /* v152: PWA install support — serve sw.js, manifest and icons from the worker
       origin (same source of truth as the page: GitHub Pages first, jsDelivr fallback)
       so the app at /app is a real installable PWA on Android AND iPhone. */
    const PWA: Record<string,[string,string]> = {
      '/sw.js': ['application/javascript; charset=utf-8', 'text/javascript'],
      '/manifest.json': ['application/manifest+json; charset=utf-8', 'text/manifest'],
      '/icon-192.png': ['image/png', 'image/png'],
      '/icon-512.png': ['image/png', 'image/png'],
      '/icon-maskable-512.png': ['image/png', 'image/png'],
    };
    const pwaFile = PWA[u.pathname];
    if (pwaFile) {
      const isSw = u.pathname === '/sw.js';
      try {
        let r = await fetch('https://successeverydayww-cpu.github.io/airconnect' + u.pathname + '?w=' + Date.now(), { cf: { cacheTtl: 0 } });
        if (!r.ok) r = await fetch('https://cdn.jsdelivr.net/gh/successeverydayww-cpu/airconnect@main' + u.pathname + '?t=' + Date.now(), { cf: { cacheTtl: 0 } });
        if (!r.ok) throw new Error('upstream ' + r.status);
        const body = await r.arrayBuffer();
        return new Response(body, { status: 200, headers: {
          'Content-Type': pwaFile[0],
          'Cache-Control': isSw ? 'no-store' : 'public, max-age=86400',
          'Service-Worker-Allowed': '/',
          'Access-Control-Allow-Origin': '*',
        } });
      } catch (e: any) {
        return new Response('Asset temporarily unavailable.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    }
    return new Response(info, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
  }

  const db = d1db(env.DB);

  /* v150 diagnostics: log page loads + vcheck/register so we can SEE what a stuck
     client actually reaches (ua/cc/ip). Polling acts are NOT logged. */
  try {
    const ua = (req.headers.get('user-agent') || '').slice(0, 120);
    const cc = (req as any).cf && (req as any).cf.country || '';
    const ip = (req.headers.get('cf-connecting-ip') || '').slice(0, 45);
    if (req.method === 'GET') {
      ctx.waitUntil((env as any).DB.prepare('INSERT INTO requests(ts,act,ua,cc,ip) VALUES(?,?,?,?,?)').bind(new Date().toISOString(), 'GET ' + u.pathname, ua, cc, ip).run());
    } else {
      let pb: any = {}; try { pb = await req.clone().json(); } catch {}
      const pa = pb.act || '';
      if (['vcheck', 'register'].includes(pa)) ctx.waitUntil((env as any).DB.prepare('INSERT INTO requests(ts,act,ua,cc,ip) VALUES(?,?,?,?,?)').bind(new Date().toISOString(), pa + ' ' + String(pb.phrase || pb.name || pb.oldnum || ''), ua, cc, ip).run());
    }
  } catch (e) {}

  let b: any = {};
  try { b = await req.json(); } catch { return json({ err: 'bad json' }, 400); }
  let a = b.act;
  if (!a) { if (b.audio) a = 'stt'; else if (b.op) a = 'greet'; else if (typeof b.text === 'string' && !b.from && !b.to) a = 'xtts'; }

  try {
    /* ---------- AIR ID v1: identity gate (soft mode) ----------
       If a node holds an AIR ID and a request presents a WRONG one -> strike.
       3 strikes = automatic ban. No AIR ID sent (legacy clients) = allowed for now. */
    const AID_EXEMPT = ['register', 'claim', 'claim_email', 'alias', 'purge', 'otp', 'adminlogin', 'unban', 'migrate', 'stats', 'stats2', 'debug', 'greet', 'stt', 'tts', 'xtts', 'fetchfile', 'log', 'logs', 'adminfriends', 'adminnodes', 'adminrename', 'wclaims', 'wconfirm', 'magic_login', 'appealstart', 'appealanswer', 'cur'];
    const aidWho = String(b.node || b.from || b.user || '').replace(/[^0-9]/g, '');
    if (aidWho && !AID_EXEMPT.includes(a)) {
      const st = await loadState(db);
      const me: any = st.nodes.find((n: any) => n.number === aidWho);
      if (me && me.aid && b.aid !== undefined && String(b.aid) === me.aid) {
        const last = me.aidseen || '';
        if (Date.now() - (last ? Date.parse(last) : 0) > 120000) { me.aidseen = new Date().toISOString(); await saveState(db, st); }
      }
      if (me && me.aid && b.aid !== undefined && String(b.aid) !== me.aid) {
        /* v48 FIX (20 Sep, real-victim bug: Mmekan-Peter Obot lost his identity to this):
           NEVER auto-ban/purge on an AID mismatch. A mismatch routinely comes from a
           stale tab, a cached service worker still holding an old token, or a plain
           timing race right after an app update -- not fraud. Deleting a real user's
           node + friends over that is far worse than the risk this gate guards against.
           Reject only THIS request; keep a counter for visibility, never act on it. */
        st.strikes = st.strikes || {};
        st.strikes[aidWho] = (st.strikes[aidWho] || 0) + 1;
        await saveState(db, st);
        return json({ err: 'invalid AIR ID', strikes: st.strikes[aidWho] }, 403);
      }
    }

    if (a === 'magic_login') {
      /* v137: one-time owner recovery link. Only the SHA-256 digest is deployed;
         the private token is never stored in source or durable data. */
      const token = String(b.token || '').slice(0, 160);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))).map((x: any) => x.toString(16).padStart(2, '0')).join('');
      if (digest !== '9e1dc241867914c20ef9ed132028f3b079d8c38955b1f531fd46e1730771f188') return json({ err: 'invalid or expired recovery link' }, 403);
      const usedKey = 'magic-used:' + digest;
      if (await kvGet(db, usedKey)) return json({ err: 'recovery link already used' }, 410);
      const st = await loadState(db);
      const me: any = st.nodes.find((n: any) => n.number === '234477307375');
      if (!me) return json({ err: 'owner account not found' }, 404);
      const dev = String(b.dev || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
      if (dev) await kvPut(db, 'dev:' + dev, me.number);
      await kvPut(db, usedKey, new Date().toISOString());
      return json({ ok: true, id: me.number, name: me.name, country: me.country, aid: me.aid, phrase: me.phrase, resumed: 'secure-link' });
    }

    if (a === 'register') {
      const st = await loadState(db);
      const dev = String(b.dev || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
      const phraseIn = String(b.phrase || '').trim().toLowerCase().slice(0, 120);
      /* v47 one-number-per-device: the passphrase is the durable identity.
         1) phrase recovery (any device) 2) device-bound auto-resume 3) resume by
         saved id (with account-merge alias) 4) fresh signup (phrase issued). */
      if (phraseIn) {
        const me: any = st.nodes.find((n: any) => String(n.phrase || '').toLowerCase() === phraseIn);
        if (!me) return json({ err: 'unknown phrase' }, 404);
        if (isBanned(st, me.number)) return json({ err: 'banned' }, 403);
        /* v188 FACE-LOCK: a face-verified account on a NEW phone must prove the owner's face */
        if (dev) {
          const hasFace = await getByKey(db, 'AirConnectSettings', 'face:' + me.number);
          const bound = await kvGet(db, 'dev:' + dev);
          if (hasFace && bound !== me.number)
            return json({ need: 'face', id: me.number, name: me.name });
        }
        if (dev) await kvPut(db, 'dev:' + dev, me.number);
        return json({ ok: true, id: me.number, name: me.name, country: me.country, aid: me.aid, phrase: me.phrase, resumed: 'phrase' });
      }
      if (dev) {
        const bound = await kvGet(db, 'dev:' + dev);
        if (bound) {
          const me: any = st.nodes.find((n: any) => n.number === bound);
          if (me && !isBanned(st, me.number))
            return json({ ok: true, id: me.number, name: me.name, country: me.country, aid: me.aid, phrase: me.phrase, resumed: 'device' });
          await kvPut(db, 'dev:' + dev, '');
        }
      }
      const rme = String(b.id || '').trim();
      if (rme) {
        if (isBanned(st, rme)) return json({ err: 'banned' }, 403);
        const alias = await kvGet(db, 'alias:' + rme); // duplicate-number merge -> canonical account
        const target = alias || rme;
        const em: string = String(b.email || '').trim().toLowerCase();
        const me: any = st.nodes.find((n: any) => n.number === target) || (em ? st.nodes.find((n: any) => (n.email || '') === em) : undefined);
        if (!me) return json({ err: 'unknown number' }, 404);
        /* v188 FACE-LOCK: same guard for number-resume on a new phone */
        if (dev) {
          const hasFace2: any = await getByKey(db, 'AirConnectSettings', 'face:' + target);
          const bound2 = await kvGet(db, 'dev:' + dev);
          if (hasFace2 && bound2 !== target)
            return json({ need: 'face', id: me.number, name: me.name });
        }
        if (!me.aid) me.aid = randTok();
        if (!me.phrase) me.phrase = mkPhrase();
        await saveState(db, st);
        if (dev) await kvPut(db, 'dev:' + dev, me.number);
        return json({ ok: true, id: me.number, name: me.name, country: me.country, aid: me.aid, phrase: me.phrase, resumed: alias ? 'alias' : 'id' });
      }
      const name = sanitize(b.name, 32);
      const country = String(b.country || '');
      const cc = COUNTRIES[country] || '234';
      if (!name) return json({ err: 'name required' }, 400);
      for (let attempt = 0; attempt < 4; attempt++) {
        const st = await loadState(db);
        const regCutoff = new Date(Date.now() - 60000).toISOString();
        if (st.nodes.filter((n: any) => (n.created || '') > regCutoff).length > 25)
          return json({ err: 'too many signups, try again shortly' }, 429);
        /* v62: COMPLEX NUMBERS (skylar directive 20 Sep): cc prefix stays true to
           the country (234/1/44/254...), the rest is RANDOM — no sequential block
           anyone can guess. NG: 234+9 random (12 digits), US: 1+10 (11), UK: 44+10,
           KE: 254+9. Length kept within the 9-12 digit validator range. */
        const suffixLen = Math.min(10, Math.max(8, 12 - cc.length));
        let number = '';
        for (let tries = 0; tries < 25; tries++) {
          const buf = new Uint32Array(suffixLen);
          crypto.getRandomValues(buf);
          let suffix = '';
          for (let i = 0; i < suffixLen; i++) suffix += String(buf[i] % 10);
          if (suffix[0] === '0') suffix = (1 + (buf[0] % 9)) + suffix.slice(1);
          number = cc + suffix;
          if (!st.nodes.some((n: any) => n.number === number)) break;
        }
        const aid = randTok();
        const phrase = mkPhrase();
        /* v172 earning rails: bonuses are OWNER-CONFIGURED (default 0), credited in
           naira-equivalent on the ledger (coins x rate). Referral needs a valid referrer node. */
        const cur: any = (st as any).currency || {};
        const rate = Number(cur.rate) || 1050;
        const welcomeCoins = Number(cur.bonusWelcome) || 0;
        const refCoins = Number(cur.bonusReferral) || 0;
        const referrer = String(b.ref || '').replace(/[^0-9]/g, '');
        let bonused = 0;
        if (welcomeCoins > 0) bonused = Math.round(welcomeCoins * rate);
        st.nodes.push({ name, country, number, status: 'active', created: new Date().toISOString(), aid, phrase });
        if (refCoins > 0 && referrer && referrer !== number && st.nodes.some((n: any) => n.number === referrer)) {
          const rb = await walGet(db, referrer);
          await walSet(db, referrer, rb + Math.round(refCoins * rate), undefined);
        }
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        if (chk.nodes.some((n: any) => n.number === number && n.name === name)) {
          if (bonused > 0) { try { await walSet(db, number, (await walGet(db, number)) + bonused, undefined); } catch (e) {} }
          if (dev) await kvPut(db, 'dev:' + dev, number);
          return json({ ok: true, id: number, name, country, aid, phrase, resumed: 'new', bonus: welcomeCoins || 0 });
        }
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'friend') {
      const from = String(b.from || ''), to = String(b.to || '');
      if (!from || !to) return json({ err: 'from/to required' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, from) || isBanned(st, to)) return json({ err: 'banned' }, 403);
        if (!st.nodes.find((n: any) => n.number === from) || !st.nodes.find((n: any) => n.number === to))
          return json({ err: 'unknown number' }, 404);
        if (isBlockedPair(st, from, to)) return json({ err: 'not available' }, 403);
        const frCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        if (st.requests.filter((r: any) => r.fromNum === from && r.created > frCutoff).length >= 20)
          return json({ err: 'too many requests — slow down' }, 429);
        const pair = [from, to].sort();
        if (st.friends.some((f: any) => f.a === pair[0] && f.b === pair[1]))
          return json({ ok: true, note: 'already friends' });
        const id = rid();
        st.requests.push({ id, fromNum: from, toNum: to, status: 'pending', created: new Date().toISOString() });
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        if (chk.requests.some((x: any) => x.id === id)) return json({ ok: true, id });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'accept') {
      const user = String(b.user || ''), id = String(b.id || '');
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, user)) return json({ err: 'banned' }, 403);
        const r: any = st.requests.find((x: any) => x.id === id && x.toNum === user && (x.status || 'pending') === 'pending');
        if (!r) return json({ err: 'request not found' }, 404);
        const pair = [r.fromNum, r.toNum].sort();
        if (!st.friends.some((f: any) => f.a === pair[0] && f.b === pair[1]))
          st.friends.push({ a: pair[0], b: pair[1] });
        r.status = 'accepted';
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        const cr: any = chk.requests.find((x: any) => x.id === id);
        if (cr && cr.status === 'accepted' && chk.friends.some((f: any) => f.a === pair[0] && f.b === pair[1]))
          return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'whois') { /* v158 (skylar): name lookup by number — the AI receptionist greets callers by their registered app name */
      const from = String(b.from || ''), num = String(b.num || '').replace(/[^0-9]/g, '');
      if (!/^\d{9,12}$/.test(from) || !/^\d{9,12}$/.test(num)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const me: any = st.nodes.find((n: any) => n.number === from);
      const tn: any = st.nodes.find((n: any) => n.number === num);
      if (!me || !tn) return json({ ok: true, name: '', about: '' });
      let vname = ''; /* v159.1 (his direction): receipts prove the ACCOUNT HOLDER (could be a business
         or someone else paying) — so the payment name is evidence only, never an identity override */
      try { const vr: any = await getByKey(db, 'AirConnectSettings', 'vname:' + num); if (vr) vname = String(JSON.parse(vr.v).name || ''); } catch (e) { }
      return json({ ok: true, name: sanitize(tn.name || '', 60), verified: !!vname || !!tn.kyc, pname: sanitize(vname, 60), about: sanitize(tn.about || '', 300) });
    }
    if (a === 'kyc') { /* v188 (Samuel, voice directive 29 Sep): KYC = FACE + CARD. The user snaps a
       clear photo of the ID card AND a clean selfie. The card must be a genuine government document;
       the selfie must show exactly one human face and becomes the account's FACEPRINT (edge image
       embedding) — after that, ONLY the verified face can open the account on a new phone
       (register/facecheck challenge). Raw ID numbers are never stored — only a SHA hash.
       Legacy single-photo flow (holding ID next to face) still works for old clients (no sfid). */
      const node = String(b.node || ''), fid = String(b.fid || '').slice(0, 64);
      const sfid = String(b.sfid || '').slice(0, 64); /* v188: selfie file id */
      const fdev = String(b.dev || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64); /* v188: device to trust after enrollment */
      if (!/^\d{9,12}$/.test(node) || !fid) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const me: any = st.nodes.find((n: any) => n.number === node);
      if (!me) return json({ err: 'unknown' }, 404);
      try { const cur: any = await getByKey(db, 'AirConnectSettings', 'kyc:' + node); if (cur) { const cp = JSON.parse(cur.v); if (cp && cp.v) return json({ ok: true, verified: true, name: cp.name || '' }); } } catch (e) { }
      const day = new Date().toISOString().slice(0, 10);
      const ck = 'kycn:' + node + ':' + day;
      const cntRow: any = await getByKey(db, 'AirConnectSettings', ck);
      const cnt = cntRow ? Number(JSON.parse(cntRow.v).n || 0) : 0;
      if (cnt >= (sfid ? 5 : 2)) return json({ ok: false, err: 'KYC limit reached for today — try again tomorrow' });
      const b64 = await f2Reassemble(db, fid);
      if (!b64) return json({ ok: false, err: 'image not found — upload again' });
      const raw = b64.startsWith('data:') ? b64.split(',')[1] : b64;
      const bin = Uint8Array.from(atob(raw.slice(0, 600000)), (ch: string) => ch.charCodeAt(0));
      const img = [...bin];
      const g1: any = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', { image: img, prompt: sfid ? 'Is this image a genuine government identity document (national ID card, international passport, or driver license)? Answer starting with YES or NO.' : 'Is this image a genuine government identity document (national ID card, international passport, or driver license) shown together with the face of the person holding it? Answer starting with YES or NO.', max_tokens: 40 });
      const gt = String((g1 && (g1.response || g1.description || g1.short_answer)) || '').trim();
      if (!/^\s*yes\b/i.test(gt)) {
        if (cntRow) await db.entities.AirConnectSettings.update(cntRow.id, { k: ck, v: JSON.stringify({ n: cnt + 1 }) });
        else await db.entities.AirConnectSettings.create({ k: ck, v: JSON.stringify({ n: cnt + 1 }) });
        return json({ ok: false, err: 'Upload a clear photo of yourself HOLDING your national ID, passport, or driver license — your face and the document must both be visible' });
      }
      /* v161 (his question: "someone can use another person's ID"): FACE MATCH — the vision AI
         compares the face of the person HOLDING the ID with the photo printed on the ID itself.
         A borrowed or stolen ID fails here, because the holder's face does not match the ID photo. */
      const gf: any = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', { image: img, prompt: 'This image shows a person holding a government identity document. Compare the face of the person HOLDING the document with the photo printed on the document. Are they the same person? Answer with exactly one word: YES, NO, or UNCLEAR.', max_tokens: 20 });
      const ftt = String((gf && (gf.response || gf.description || gf.short_answer)) || '').trim().toUpperCase();
      const fc = ftt.indexOf('YES') === 0 ? 'yes' : (ftt.indexOf('NO') === 0 ? 'no' : 'unclear');
      if (!sfid && fc === 'no') { /* v160 in-image match only for the legacy single-photo flow */
        if (cntRow) await db.entities.AirConnectSettings.update(cntRow.id, { k: ck, v: JSON.stringify({ n: cnt + 1 }) });
        else await db.entities.AirConnectSettings.create({ k: ck, v: JSON.stringify({ n: cnt + 1 }) });
        try { await pushNotify(db, st, '234100000001', { what: 'chat', from: node, fromName: 'KYC', text: '🚨 KYC face-match FAILED: +' + node + ' — the face holding the ID does not match the photo on the ID' }); } catch (e) { }
        return json({ ok: false, err: 'We could not confirm this ID is yours — the face holding the ID does not match the photo on the ID. If this is a mistake, retake the photo in clear light with your face fully visible next to the document.' });
      }
      const g2: any = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', { image: img, prompt: 'Read the FULL NAME of the document holder exactly as printed on this identity document. Output ONLY the name. If unreadable, output NONE.', max_tokens: 60 });
      let kname = sanitize(String((g2 && (g2.response || g2.description || g2.short_answer)) || '').trim(), 80);
      if (/^(none|n\/a|unknown|not\b)/i.test(kname) || kname.length < 3) kname = '';
      const g3: any = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', { image: img, prompt: 'Read the identity/document number exactly as printed on this identity document (NIN, passport number, license number). Output ONLY the number. If unreadable, output NONE.', max_tokens: 50 });
      let idn = String((g3 && (g3.response || g3.description || g3.short_answer)) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (/^(NONE|NA|UNKNOWN)$/.test(idn)) idn = '';
      if (cntRow) await db.entities.AirConnectSettings.update(cntRow.id, { k: ck, v: JSON.stringify({ n: cnt + 1 }) });
      else await db.entities.AirConnectSettings.create({ k: ck, v: JSON.stringify({ n: cnt + 1 }) });
      if (!kname && !idn) return json({ ok: false, err: 'Could not read the ID clearly — retake the photo with all text sharp and well-lit' });
      if (!idn) return json({ ok: false, err: 'Could not read the ID number — make sure the number is fully visible and sharp' });
      const idh = await shaHex('kyc:' + idn);
      const taken: any = await getByKey(db, 'AirConnectSettings', 'kycidh:' + idh);
      if (taken) { try { const tp = JSON.parse(taken.v); if (tp.node !== node) return json({ ok: false, err: 'This identity number is already verified on another account — one ID can verify only one account' }); } catch (e) { } }
      const reg = String(me.name || '');
      /* v195 (Samuel, voice directive): the important security questions ride with the submission —
         stored on the KYC row for our team and never shown to other users. */
      const qa: string[] = (Array.isArray(b.qa) ? b.qa : []).map((x: any) => String(x || '').replace(/[<>]/g, '').trim().slice(0, 120)).filter((x: string) => x.length >= 2).slice(0, 5);
      const toks = (x: string) => x.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w: string) => w.length >= 3);
      const kt = toks(kname), rt = toks(reg);
      const nameMatch = !!kname && !!reg && (kt.some((w: string) => rt.indexOf(w) >= 0) || kname.toLowerCase().indexOf(reg.toLowerCase()) >= 0 || reg.toLowerCase().indexOf(kname.toLowerCase()) >= 0);
      /* v188 FACEPRINT ENROLLMENT — the selfie becomes the account's face.
         One clean face required; the image is turned into an edge embedding that
         ONLY the same face can reproduce at login from a new phone. */
      let faceOK = false, sim = 0;
      if (sfid) {
        const sb64 = await f2Reassemble(db, sfid);
        if (!sb64) return json({ ok: false, err: 'Selfie upload not found — retake your face photo and try again' });
        const sraw = sb64.startsWith('data:') ? sb64.split(',')[1] : sb64;
        const sbin = Uint8Array.from(atob(sraw.slice(0, 600000)), (ch: string) => ch.charCodeAt(0));
        const gs: any = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', { image: [...sbin], prompt: 'Does this photo show exactly one clear, well-lit human face looking at the camera? Answer starting with YES or NO.', max_tokens: 20 });
        const gst = String((gs && (gs.response || gs.description || gs.short_answer)) || '').trim();
        if (!/^\s*yes\b/i.test(gst))
          return json({ ok: false, err: 'Retake your selfie — your face must be clear, well-lit and looking at the camera' });
        try {
          const ge: any = await env.AI.run('@cf/baai/bge-image-embeddings', { image: [...sbin] });
          const e = (ge && (ge.data || ge.response || ge.embedding)) || null;
          if (Array.isArray(e) && e.length >= 64) {
            const er = e.map((x: any) => Math.round(Number(x) * 10000) / 10000);
            const frow = JSON.stringify({ e: er, at: Date.now() });
            const oldF: any = await getByKey(db, 'AirConnectSettings', 'face:' + node);
            if (oldF) await db.entities.AirConnectSettings.update(oldF.id, { k: 'face:' + node, v: frow });
            else await db.entities.AirConnectSettings.create({ k: 'face:' + node, v: frow });
            faceOK = true;
          }
        } catch (e2) { }
        if (!faceOK) return json({ ok: false, err: 'Face engine unavailable right now — try again in a moment' });
        if (fdev) await kvPut(db, 'dev:' + fdev, node); /* this phone is now the trusted device */
      }
      if (sfid && faceOK) { /* v188: FACE + CARD is the verification — once done, it is done */
        /* v189 (Samuel, voice directive): the name on the CARD is the name that
           appears on the profile — not the name the user typed. */
        const cleanName = (kname || '').replace(/[^A-Za-z .\u00C0-\u024F'\-]/g, '').trim();
        const OWNER_NUM = '234100000001';
        /* v192 (Samuel, voice directive 29 Sep): EVERY user except the owner enters a
           firm 2-BUSINESS-DAY review window before the badge and card-name go live —
           the owner alone is verified immediately. The cron below finalizes pending
           rows automatically once their window elapses; nothing further to trigger. */
        if (node === OWNER_NUM) {
          if (cleanName.length >= 3 && cleanName.length <= 60) me.name = cleanName;
          me.kyc = 1;
          await saveState(db, st);
          const krow = JSON.stringify({ v: 1, name: kname, idh, fc: 'face', at: Date.now(), qa });
          const oldK: any = await getByKey(db, 'AirConnectSettings', 'kyc:' + node);
          if (oldK) await db.entities.AirConnectSettings.update(oldK.id, { k: 'kyc:' + node, v: krow });
          else await db.entities.AirConnectSettings.create({ k: 'kyc:' + node, v: krow });
          await db.entities.AirConnectSettings.create({ k: 'kycidh:' + idh, v: JSON.stringify({ node, at: Date.now() }) });
          try { await pushNotify(db, st, OWNER_NUM, { what: 'chat', from: node, fromName: 'KYC', text: '✅ KYC face+card verified: +' + node + ' — ID "' + (kname || 'card') + '" · faceprint enrolled · new-phone logins now need the owner face · ' + qa.length + '/5 security answers on file' }); } catch (e) { }
          return json({ ok: true, verified: true, pending: false, name: me.name || kname || reg, face: true });
        }
        const approveAt = bizDaysFromNow(2);
        const prow2 = JSON.stringify({ v: 0, pending: 1, name: cleanName || kname, idh, fc: 'face', at: Date.now(), approveAt, qa });
        const oldP2: any = await getByKey(db, 'AirConnectSettings', 'kyc:' + node);
        if (oldP2) await db.entities.AirConnectSettings.update(oldP2.id, { k: 'kyc:' + node, v: prow2 });
        else await db.entities.AirConnectSettings.create({ k: 'kyc:' + node, v: prow2 });
        try { await pushNotify(db, st, OWNER_NUM, { what: 'chat', from: node, fromName: 'KYC', text: '🕑 KYC submitted: +' + node + ' — ID "' + (kname || 'card') + '" · faceprint enrolled · ' + qa.length + '/5 security answers on file · auto-verifies in 2 business days' }); } catch (e) { }
        return json({ ok: true, verified: false, pending: true, days: 2, name: cleanName || kname, face: true });
      }
      if (nameMatch) {
        me.kyc = 1;
        await saveState(db, st);
        const krow = JSON.stringify({ v: 1, name: kname, idh, fc, at: Date.now(), qa });
        const oldK: any = await getByKey(db, 'AirConnectSettings', 'kyc:' + node);
        if (oldK) await db.entities.AirConnectSettings.update(oldK.id, { k: 'kyc:' + node, v: krow });
        else await db.entities.AirConnectSettings.create({ k: 'kyc:' + node, v: krow });
        await db.entities.AirConnectSettings.create({ k: 'kycidh:' + idh, v: JSON.stringify({ node, at: Date.now() }) });
        try { await pushNotify(db, st, '234100000001', { what: 'chat', from: node, fromName: 'KYC', text: '✅ KYC verified: +' + node + ' — ID name "' + kname + '" matches profile "' + reg + '"' + (fc === 'yes' ? ' · face match confirmed' : ' · face check unclear — spot-check when convenient') }); } catch (e) { }
        return json({ ok: true, verified: true, name: kname });
      }
      const prow = JSON.stringify({ v: 0, name: kname, idh, fc, at: Date.now(), qa, pending: 'name mismatch: profile "' + reg + '" vs ID "' + kname + '"' });
      const oldP: any = await getByKey(db, 'AirConnectSettings', 'kyc:' + node);
      if (oldP) await db.entities.AirConnectSettings.update(oldP.id, { k: 'kyc:' + node, v: prow });
      else await db.entities.AirConnectSettings.create({ k: 'kyc:' + node, v: prow });
      try { await pushNotify(db, st, '234100000001', { what: 'chat', from: node, fromName: 'KYC', text: '🟡 KYC review: +' + node + ' profile "' + reg + '" vs ID "' + (kname || '(unreadable)') + '" — grant via kycgrant if genuine' }); } catch (e) { }
      return json({ ok: false, err: 'The name on your ID ("' + (kname || '') + '") does not match your profile name ("' + reg + '"). Update your profile name to your real name, then try again.', pending: true });
    }
    if (a === 'facecheck') { /* v188 (Samuel): FACE-LOCK. An account verified by face can only be
       opened on a NEW phone by the SAME face. The client sends a fresh selfie; the edge compares
       its embedding with the enrolled faceprint. Match -> this phone becomes a trusted device.
       Unclear -> retake. Different face -> refused. Attempts are capped per day. */
      const id = String(b.id || '').replace(/[^0-9]/g, '');
      const fid = String(b.fid || '').slice(0, 64);
      const dev = String(b.dev || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
      if (!/^\d{9,12}$/.test(id) || !fid || !dev) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, id)) return json({ err: 'banned' }, 403);
      const me: any = st.nodes.find((n: any) => n.number === id);
      if (!me) return json({ err: 'unknown' }, 404);
      const phraseIn = String(b.phrase || '').trim().toLowerCase().slice(0, 120);
      if (phraseIn && String(me.phrase || '').toLowerCase() !== phraseIn) return json({ err: 'wrong phrase' }, 403);
      const frow: any = await getByKey(db, 'AirConnectSettings', 'face:' + id);
      let se: any[] = [];
      try { se = (JSON.parse(frow.v) || {}).e || []; } catch (e) { }
      if (!frow || !se.length) return json({ err: 'no face on file' }, 404);
      const day = new Date().toISOString().slice(0, 10);
      const ck = 'fball:' + id + ':' + day;
      const cntRow: any = await getByKey(db, 'AirConnectSettings', ck);
      const cnt = cntRow ? Number(JSON.parse(cntRow.v).n || 0) : 0;
      if (cnt >= 15) return json({ ok: false, err: 'Too many face attempts today — try again tomorrow' });
      const bump = async () => { if (cntRow) await db.entities.AirConnectSettings.update(cntRow.id, { k: ck, v: JSON.stringify({ n: cnt + 1 }) }); else await db.entities.AirConnectSettings.create({ k: ck, v: JSON.stringify({ n: cnt + 1 }) }); };
      const sb64 = await f2Reassemble(db, fid);
      if (!sb64) return json({ ok: false, err: 'Selfie upload not found — retake and try again' });
      const sraw = sb64.startsWith('data:') ? sb64.split(',')[1] : sb64;
      const sbin = Uint8Array.from(atob(sraw.slice(0, 600000)), (ch: string) => ch.charCodeAt(0));
      let e: any[] = [];
      try { const ge: any = await env.AI.run('@cf/baai/bge-image-embeddings', { image: [...sbin] }); e = (ge && (ge.data || ge.response || ge.embedding)) || []; } catch (e2) { }
      if (!e.length) return json({ ok: false, err: 'Face engine unavailable — try again in a moment' });
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < Math.min(e.length, se.length); i++) { dot += Number(e[i]) * Number(se[i]); na += Number(e[i]) * Number(e[i]); nb += Number(se[i]) * Number(se[i]); }
      const sim = dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
      const thr = Number(await kvGet(db, 'facesim')) || 0.8;
      if (sim >= thr) {
        await kvPut(db, 'dev:' + dev, id); /* verified face -> this phone is trusted */
        await bump();
        return json({ ok: true, id: me.number, name: me.name, country: me.country, aid: me.aid, phrase: me.phrase, resumed: 'face', sim: Math.round(sim * 100) / 100 });
      }
      await bump();
      if (sim >= thr - 0.14)
        return json({ ok: false, retry: true, sim: Math.round(sim * 100) / 100, err: 'Face unclear — retake your selfie in better light, looking straight at the camera' });
      return json({ ok: false, sim: Math.round(sim * 100) / 100, err: 'Face does not match the verified owner of this account' });
    }
    if (a === 'kycstate') { /* v160: lightweight KYC status for the client */
      const node = String(b.node || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      try { const r: any = await getByKey(db, 'AirConnectSettings', 'kyc:' + node); if (r) { const p = JSON.parse(r.v); return json({ ok: true, v: !!p.v, name: p.name || '', pending: !!p.pending, approveAt: p.approveAt || 0, daysLeft: p.approveAt ? Math.max(0, Math.ceil((p.approveAt - Date.now()) / 86400000)) : 0 }); } } catch (e) { } /* v192: pending window surfaced to the client */
      return json({ ok: true, v: false });
    }
    if (a === 'kycgrant') { /* v160: owner-only manual grant for genuine mismatch cases (transliteration, name order) */
      const node = String(b.node || ''), tk = String(b.tk || '');
      if (String(tk) !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      const me: any = st.nodes.find((n: any) => n.number === node);
      if (!me) return json({ err: 'unknown' }, 404);
      const krow: any = await getByKey(db, 'AirConnectSettings', 'kyc:' + node);
      if (!krow) return json({ err: 'no kyc record' }, 404);
      const p = JSON.parse(krow.v);
      me.kyc = 1;
      await saveState(db, st);
      await db.entities.AirConnectSettings.update(krow.id, { k: 'kyc:' + node, v: JSON.stringify({ ...p, v: 1, grantedBy: 'owner', at: Date.now() }) });
      await db.entities.AirConnectSettings.create({ k: 'kycidh:' + p.idh, v: JSON.stringify({ node, at: Date.now() }) });
      try { await pushNotify(db, st, node, { what: 'chat', from: node, fromName: 'AirConnect', text: '✅ Your identity has been verified — the badge is now on your profile. Thank you!' }); } catch (e) { }
      return json({ ok: true, verified: true });
    }
    if (a === 'friends') {
      const node = String(b.node || '');
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const fl = st.friends.filter((f: any) => f.a === node || f.b === node)
        .map((f: any) => {
          const other = f.a === node ? f.b : f.a;
          const n: any = st.nodes.find((x: any) => x.number === other);
          return { id: other, name: n ? n.name : 'unknown', kc: !!(n && n.kyc) };
        });
      const rl = st.requests.filter((r: any) => r.toNum === node && (r.status || 'pending') === 'pending' && !isBlockedPair(st, node, r.fromNum))
        .map((r: any) => ({ id: r.id, from: r.fromNum }));
      const myBlocks = st.blocks.filter((b: any) => b.by === node).map((b: any) => b.who);
      const meF: any = st.nodes.find((x: any) => x.number === node);
      const mykc = !!(meF && meF.kyc); /* v160: own KYC status rides along with the friends call — zero extra reads */
      for (let i = fl.length - 1; i >= 0; i--) if (myBlocks.indexOf(fl[i].id) >= 0) fl.splice(i, 1);
      const pks: Record<string, string> = {};
      const pkSet = new Set<string>([node]);
      for (const f of fl) pkSet.add(f.id);
      for (const n of st.nodes) if (pkSet.has(n.number) && n.pk) pks[n.number] = n.pk;
      return json({ friends: fl, requests: rl, pks, blocks: myBlocks, mykc });
    }

    if (a === 'pubkey') {
      const node = String(b.node || ''), pk = String(b.pk || '');
      if (!/^\d{9,12}$/.test(node) || pk.length > 400) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, node)) return json({ err: 'banned' }, 403);
        const me: any = st.nodes.find((n: any) => n.number === node);
        if (!me) return json({ err: 'unknown number' }, 404);
        if (me.pk !== pk) { me.pk = pk; trimState(st); await saveState(db, st); }
        return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'vcheck') {
      return json({ ok: true, minv: MIN_CLIENT, v: CUR_CLIENT });
    }
    /* ===== v172 (skylar, 29 Sep): ACOIN CURRENCY LAYER =====
       Ledger stays in naira — the currency layer is pure config + display conversion,
       so nothing existing can break. rate = naira per 1 Acoin (default 1050, his instruction). */
    if (a === 'cur') {
      const st = await loadState(db);
      const c = (st as any).currency || { name: 'Acoin', ticker: 'AIRC', rate: 1050 };
      return json({ ok: true, name: c.name || 'Acoin', ticker: c.ticker || 'AIRC', rate: Number(c.rate) || 1050, disp: c.disp || 'naira' });
    }

    if (a === 'aircfg') {
      if (String(b.tk || '') !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      const st = await loadState(db);
      const prev: any = (st as any).currency || {};
      (st as any).currency = {
        name: String(b.name || prev.name || 'Acoin').slice(0, 24),
        ticker: String(b.ticker || prev.ticker || 'AIRC').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase(),
        rate: Math.max(1, Math.round(Number(b.rate) || prev.rate || 1050)),
        /* v172 earning rails (skylar): welcome bonus per new signup + referral bonus per
           invited friend, in Acoin. Stored but ZERO until the owner sets them — no free
           minting without his explicit decision. */
        disp: String(b.disp || prev.disp || 'naira') === 'acoin' ? 'acoin' : 'naira',
        bonusWelcome: Math.max(0, Math.round((Number(b.bonusWelcome) >= 0 ? Number(b.bonusWelcome) : prev.bonusWelcome) * 100) / 100) || 0,
        bonusReferral: Math.max(0, Math.round((Number(b.bonusReferral) >= 0 ? Number(b.bonusReferral) : prev.bonusReferral) * 100) / 100) || 0,
        set: new Date().toISOString(),
      };
      await saveState(db, st);
      return json({ ok: true, cur: (st as any).currency });
    }

    if (a === 'stats') {
      const st = await loadState(db);
      const v = JSON.stringify(st);
      return json({ v: v.length, nodes: st.nodes.length, sigs: st.sigs.length, msgs: st.msgs.length, subs: st.subs.length });
    }

    if (a === 'turncfg') {
      /* returns fresh Cloudflare TURN iceServers if TURN_KEY_ID+TURN_API_TOKEN secrets are set */
      if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return json({ ok: false });
      try {
        const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + env.TURN_KEY_ID + '/credentials/generate-ice-servers', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + env.TURN_API_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 3600 })
        });
        if (!r.ok) return json({ ok: false, status: r.status });
        const data: any = await r.json();
        if (!data.iceServers || !data.iceServers.length) return json({ ok: false });
        return json({ ok: true, iceServers: data.iceServers, ttl: 3600 });
      } catch (e: any) { return json({ ok: false, err: String(e).slice(0, 80) }); }
    }

    if (a === 'sfusess') {
      if (!env.SFU_APP_ID || !env.SFU_SECRET) return json({ ok: false, err: 'sfu not configured' });
      const from = String(b.from || '');
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      if (!st.nodes.find((n: any) => n.number === from)) return json({ err: 'unknown node' }, 404);
      const r = await sfuFetch(env, '/sessions/new', 'POST', null);
      if (r.sessionId) return json({ ok: true, sid: r.sessionId });
      return json({ ok: false, err: 'sfu ' + (r._http || '?') + ' ' + String(r.errorDescription || '').slice(0, 60) });
    }

    if (a === 'sfupub') {
      /* publish local audio track: relay browser offer -> SFU answer */
      const from = String(b.from || ''), sid = String(b.sid || ''), sdp = String(b.sdp || ''), mid = String(b.mid || '');
      if (!sid || !sdp || !mid) return json({ err: 'sid/sdp/mid required' }, 400);
      const r = await sfuFetch(env, '/sessions/' + sid + '/tracks/new', 'POST', {
        sessionDescription: { type: 'offer', sdp },
        tracks: [{ location: 'local', mid, trackName: 'audio' }]
      });
      if (r._http === 200 && r.sessionDescription && r.sessionDescription.sdp)
        return json({ ok: true, sdp: r.sessionDescription.sdp });
      return json({ ok: false, err: 'sfu ' + (r._http || '?') + ' ' + String(r.errorDescription || r.errorCode || '').slice(0, 80) });
    }

    if (a === 'sfusub') {
      /* subscribe to a remote member's audio: SFU generates offer, client answers via sfureneg */
      const from = String(b.from || ''), sid = String(b.sid || ''), rsid = String(b.rsid || ''), gid = String(b.gid || '');
      if (!sid || !rsid) return json({ err: 'sid/rsid required' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      if (gid) {
        const grp: any = st.groups.find((g: any) => g.id === gid);
        if (!grp || (grp.members || []).indexOf(from) < 0) return json({ err: 'not a member' }, 403);
      }
      const track = String(b.track || 'audio') === 'video' ? 'video' : 'audio';
      const r = await sfuFetch(env, '/sessions/' + sid + '/tracks/new', 'POST', {
        tracks: [{ location: 'remote', sessionId: rsid, trackName: track, kind: track }]
      });
      if (r._http === 200 && r.sessionDescription && r.sessionDescription.sdp)
        return json({ ok: true, sdp: r.sessionDescription.sdp, reneg: !!r.requiresImmediateRenegotiation });
      return json({ ok: false, err: 'sfu ' + (r._http || '?') + ' ' + String(r.errorDescription || r.errorCode || '').slice(0, 80) });
    }

    if (a === 'sfureneg') {
      const from = String(b.from || ''), sid = String(b.sid || ''), sdp = String(b.sdp || '');
      if (!sid || !sdp) return json({ err: 'sid/sdp required' }, 400);
      const r = await sfuFetch(env, '/sessions/' + sid + '/renegotiate', 'PUT', { sessionDescription: { type: 'answer', sdp } });
      return json({ ok: r._http === 200, err: r._http !== 200 ? String(r.errorDescription || r.errorCode || '').slice(0, 80) : undefined });
    }

    if (a === 'sfuleave') {
      const from = String(b.from || ''), sid = String(b.sid || '');
      const mids: any[] = Array.isArray(b.mids) ? b.mids : [];
      if (sid && mids.length) {
        await sfuFetch(env, '/sessions/' + sid + '/tracks/close', 'PUT', { tracks: mids.map((m: any) => ({ mid: String(m) })) });
      }
      if (sid) {
        try {
          const reg = await gcReg(db);
          for (const gk of Object.keys(reg.v || {})) {
            const arr = reg.v[gk] || [];
            const keep = arr.filter((e: any) => e.s !== sid);
            if (keep.length !== arr.length) { reg.v[gk] = keep; await gcRegSave(db, reg.v); break; }
          }
        } catch (e) { }
      }
      return json({ ok: true });
    }

    if (a === 'sfureg') {
      /* register/refresh (or remove with off=1) my sfu session in a group call */
      const from = String(b.from || ''), gid = String(b.gid || ''), sid = String(b.sid || '');
      if (!from || !gid || !sid) return json({ err: 'from/gid/sid required' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const grp: any = st.groups.find((g: any) => g.id === gid);
      if (!grp || (grp.members || []).indexOf(from) < 0) return json({ err: 'not a member' }, 403);
      for (let attempt = 0; attempt < 3; attempt++) {
        const reg: any = await gcReg(db);
        reg.v = reg.v || {};
        const arr = (reg.v[gid] || []).filter((e: any) => e.n !== from && e.s !== sid && (Date.now() - Number(e.t || 0)) < 90000);
        if (!b.off) arr.push({ n: from, s: sid, t: Date.now(), v: b.v ? 1 : 0 });
        reg.v[gid] = arr;
        const before = JSON.stringify({ a: (reg.v[gid] || []).length });
        await gcRegSave(db, reg.v);
        const chk: any = await gcReg(db);
        const cur = (chk.v[gid] || []).filter((e: any) => e.n === from);
        if (b.off || cur.some((e: any) => e.s === sid && Date.now() - Number(e.t || 0) < 120000)) return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'sfumembers') {
      const from = String(b.from || ''), gid = String(b.gid || ''), sid = String(b.sid || '');
      if (!from || !gid) return json({ err: 'from/gid required' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const grp: any = st.groups.find((g: any) => g.id === gid);
      if (!grp || (grp.members || []).indexOf(from) < 0) return json({ err: 'not a member' }, 403);
      const reg = await gcReg(db);
      const now = Date.now();
      const arr = ((reg.v || {})[gid] || []).filter((e: any) => now - Number(e.t || 0) < 90000 && e.n !== from);
      if (sid) {
        /* refresh my own heartbeat */
        try {
          const mine = ((reg.v || {})[gid] || []).find((e: any) => e.n === from && e.s === sid);
          if (mine) { mine.t = now; await gcRegSave(db, reg.v); }
        } catch (e) { }
      }
      return json({ ok: true, members: arr.map((e: any) => ({ n: e.n, s: e.s, v: e.v ? 1 : 0 })) });
    }

    if (a === 'sfuvid') {
      /* publish local video track: renegotiation offer -> SFU answer */
      const from = String(b.from || ''), sid = String(b.sid || ''), sdp = String(b.sdp || ''), mid = String(b.mid || '');
      if (!sid || !sdp || !mid) return json({ err: 'sid/sdp/mid required' }, 400);
      const r = await sfuFetch(env, '/sessions/' + sid + '/tracks/new', 'POST', {
        sessionDescription: { type: 'offer', sdp },
        tracks: [{ location: 'local', mid, trackName: 'video' }]
      });
      if (r._http === 200 && r.sessionDescription && r.sessionDescription.sdp)
        return json({ ok: true, sdp: r.sessionDescription.sdp });
      return json({ ok: false, err: 'sfu ' + (r._http || '?') + ' ' + String(r.errorDescription || r.errorCode || '').slice(0, 80) });
    }

    if (a === 'sfuclose') {
      /* close one of my tracks (camera off) */
      const from = String(b.from || ''), sid = String(b.sid || ''), mid = String(b.mid || '');
      if (!sid || !mid) return json({ err: 'sid/mid required' }, 400);
      const r = await sfuFetch(env, '/sessions/' + sid + '/tracks/close', 'PUT', { tracks: [{ mid }] });
      return json({ ok: r._http === 200, err: r._http !== 200 ? String(r.errorDescription || r.errorCode || '').slice(0, 80) : undefined });
    }

    if (a === 'fstart') {
      /* v34: any-size chat video — client-streamed chunk upload. meta row f2:<fid>. 7-day retention.
         v39: pub=1 = PUBLIC Watch upload (to=self, no friend gate, anyone may fetch via fget). */
      const from = String(b.from || ''), to = String(b.to || ''), name = String(b.name || 'video').slice(0, 80);
      const n = Number(b.n || 0);
      const pub = b.pub === 1 || b.pub === true;
      if (!from || !to || !/^\d{9,12}$/.test(from) || !/^\d{9,12}$/.test(to)) return json({ err: 'from/to required' }, 400);
      if (!Number.isInteger(n) || n < 1 || n > 900) return json({ err: 'bad chunk count' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      if (!pub) {
        const pair = [from, to].sort();
        if (!st.friends.some((f: any) => f.a === pair[0] && f.b === pair[1])) return json({ err: 'not friends' }, 403);
      }
      const fid = rid();
      try { await db.entities.AirConnectSettings.create({ k: 'f2:' + fid, v: JSON.stringify({ from, to: pub ? from : to, name, n, ts: Date.now(), pub: pub ? 1 : 0 }) }); }
      catch (e) { return json({ err: 'could not start upload' }, 503); }
      /* v73 skylar directive: NOTHING is ever deleted — videos, reactions, comments and views are kept permanently */
      return json({ ok: true, fid });
    }

    if (a === 'fput') {
      const from = String(b.from || ''), fid = String(b.fid || ''), ci = Number(b.ci), v = String(b.v || '');
      if (!fid || !Number.isInteger(ci) || ci < 0 || ci > 899 || !v || v.length > 310000) return json({ err: 'invalid chunk' }, 400); /* v60 (skylar): 3x bigger chunks — a 100MB video now fits inside the 900-chunk cap (was: silently truncated above ~67MB) and uploads ~3x faster for his <20s standard */
      // v65: targeted key lookups instead of a full settings-table scan on every chunk upload
      const meta: any = await getByKey(db, 'AirConnectSettings', 'f2:' + fid);
      if (!meta) return json({ err: 'unknown upload' }, 404);
      let m: any; try { m = JSON.parse(meta.v); } catch { return json({ err: 'corrupt upload' }, 403); }
      if (m.from !== from) return json({ err: 'forbidden' }, 403);
      if (ci >= m.n) return json({ err: 'chunk out of range' }, 400);
      const exists: any = await getByKey(db, 'AirConnectSettings', 'f2:' + fid + ':c' + ci);
      if (exists) return json({ ok: true });
      try { await db.entities.AirConnectSettings.create({ k: 'f2:' + fid + ':c' + ci, v }); } catch (e) { return json({ err: 'upload interrupted — retrying is safe' }, 503); }
      return json({ ok: true });
    }

    if (a === 'fend') {
      const from = String(b.from || ''), fid = String(b.fid || '');
      // v65: targeted prefix lookup instead of a full settings-table scan
      const meta: any = await getByKey(db, 'AirConnectSettings', 'f2:' + fid);
      if (!meta) return json({ err: 'unknown upload' }, 404);
      let m: any; try { m = JSON.parse(meta.v); } catch { return json({ err: 'corrupt upload' }, 403); }
      if (m.from !== from) return json({ err: 'forbidden' }, 403);
      const chunkRows = await listByPrefix(db, 'AirConnectSettings', ['f2:' + fid + ':c']);
      const got = chunkRows.filter((r: any) => /^f2:.*:c\d+$/.test(String(r.k || ''))).map((r: any) => Number(String(r.k).split(':c')[1]));
      if (got.length !== m.n) return json({ err: 'upload incomplete (' + got.length + '/' + m.n + ') — call fput for missing chunks' }, 400);
      /* deliver marker message to the chat */
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, from)) return json({ err: 'banned' }, 403);
        const marker = '[f2:' + fid + ':' + m.name + ':' + m.n + ']';
        const now = new Date().toISOString();
        st.msgs.push({ id: now, fromNum: from, toNum: m.to, text: marker, created: now });
        const meNode: any = st.nodes.find((x: any) => x.number === from);
        await pushNotify(db, st, m.to, { what: 'chat', from, fromName: meNode ? meNode.name : 'Someone', text: '📹 Video' });
        trimState(st); await saveState(db, st);
        const chk = await loadState(db);
        if (chk.msgs.some((x: any) => x.created === now && x.fromNum === from)) { touchSeen(from); bumpCache(); return json({ ok: true, id: now }); }
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    /* v63: bulk fetch — ALL chunks of a file in ONE request (videos used to need
       one request per chunk; on mobile that read as 'video never plays'). */
    if (a === 'fgetall') {
      const from = String(b.from || ''), fid = String(b.fid || '');
      // v65: targeted key/prefix lookups instead of a full settings-table scan —
      // this is the receipt/video read path, the exact one skylar reported as broken
      // ("clicking receipts should not be showing nothing").
      const meta: any = await getByKey(db, 'AirConnectSettings', 'f2:' + fid);
      if (!meta) return json({ err: 'unknown file' }, 404);
      let m: any; try { m = JSON.parse(meta.v); } catch { return json({ err: 'corrupt' }, 403); }
      if (m.from !== from && m.to !== from && m.pub !== 1) return json({ err: 'forbidden' }, 403);
      const n = Number(m.n || 0);
      if (!n || n > 900) return json({ err: 'bad n' }, 400); /* v113: matches the 900-chunk upload cap — big videos were unfetchable above 400 */
      const chunkRows = await listByPrefix(db, 'AirConnectSettings', ['f2:' + fid + ':c']);
      const byIdx = new Map<number, string>();
      for (const r of chunkRows) {
        const mm = /:c(\d+)$/.exec(String(r.k || ''));
        if (mm) byIdx.set(Number(mm[1]), String(r.v));
      }
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const v = byIdx.get(i);
        if (v === undefined) return json({ err: 'missing chunk ' + i }, 404);
        parts.push(v);
      }
      return json({ ok: true, n, v: parts.join('') });
    }
    if (a === 'fget') {
      const from = String(b.from || ''), fid = String(b.fid || ''), ci = Number(b.ci);
      // v65: targeted key/prefix lookups instead of a full settings-table scan
      const meta: any = await getByKey(db, 'AirConnectSettings', 'f2:' + fid);
      if (!meta) return json({ err: 'unknown file' }, 404);
      let m: any; try { m = JSON.parse(meta.v); } catch { return json({ err: 'corrupt' }, 403); }
      if (m.from !== from && m.to !== from && m.pub !== 1) return json({ err: 'forbidden' }, 403);
      if (ci === -1) {
        const chunkRows = await listByPrefix(db, 'AirConnectSettings', ['f2:' + fid + ':c']);
        const got = chunkRows.map((r: any) => Number(String(r.k).split(':c')[1])).sort((x: any, y: any) => x - y);
        return json({ ok: true, name: m.name, n: m.n, ts: m.ts, chunks: got });
      }
      const c: any = await getByKey(db, 'AirConnectSettings', 'f2:' + fid + ':c' + ci);
      if (!c) return json({ err: 'missing chunk' }, 404);
      return json({ ok: true, v: c.v });
    }

    /* ============ v39: PUBLIC WATCH FEED + CHANNELS (YouTube/Facebook-style, open to ALL users) ============ */
    if (a === 'channel') {
      const node = String(b.node || ''), name = sanitize(b.name, 60), about = sanitize(b.about, 300);
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      if (!name) return json({ err: 'name required' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const key = 'chan:' + node;
      const old: any = await getByKey(db, 'AirConnectSettings', key); /* v61: targeted */
      if (old) { await updateRec(db, 'AirConnectSettings', old.id, { v: JSON.stringify({ num: node, name, about, at: Date.now() }) }); return json({ ok: true }); }
      await db.entities.AirConnectSettings.create({ k: key, v: JSON.stringify({ num: node, name, about, at: Date.now() }) });
      return json({ ok: true });
    }
    if (a === 'channels') {
      const node = String(b.node || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const rows = await listByPrefix(db, 'AirConnectSettings', ['chan:', 'sub:', 'vch:']); /* v61: targeted — channel browse never scans upload chunks */
      const chans = [];
      const subs: any = {};
      for (const r of rows) {
        const k = String(r.k || '');
        if (k.startsWith('chan:') && !/[:#]/.test(k.slice(5))) { let c: any; try { c = JSON.parse(r.v); } catch { continue; } c.id = r.id; chans.push(c); }
        if (k.startsWith('sub:' + node + ':')) { let sv: any; try { sv = JSON.parse(r.v); } catch { continue; } Object.assign(subs, sv); }
      }
      const vset = new Set<string>();
      for (const r of rows) { const k = String(r.k || ''); if (k.startsWith('vch:')) { const mm = k.slice(4); if (!/:/.test(mm)) vset.add(mm); } }
      const subCount: any = {};
      for (const r of rows) { const k = String(r.k || ''); const m = k.match(/^sub:(\d{9,12}):/); if (m) { let sv: any; try { sv = JSON.parse(r.v); } catch { continue; } for (const cn of Object.keys(sv)) subCount[cn] = (subCount[cn] || 0) + 1; } }
      for (const c of chans) { c.subs = subCount[c.num] || 0; c.mine = c.num === node; c.subscribed = !!subs[c.num];  c.v = vset.has(c.num); }
      chans.sort((x: any, y: any) => (y.subs || 0) - (x.subs || 0));
      return json({ ok: true, channels: chans.slice(0, 100) });
    }
    if (a === 'sub') {
      const node = String(b.node || ''), to = String(b.to || ''), on = b.on !== 0 && b.on !== false;
      if (!/^\d{9,12}$/.test(node) || !/^\d{9,12}$/.test(to)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const key = 'sub:' + node + ':' + to; /* v62 targeted */
      const rr: any = await getByKey(db, 'AirConnectSettings', key);
      if (!on) { if (rr) await delRec(db, 'AirConnectSettings', rr.id); return json({ ok: true, on: false }); }
      if (!rr) { await db.entities.AirConnectSettings.create({ k: key, v: JSON.stringify({ [to]: 1, ts: Date.now() }) }); }
      return json({ ok: true, on: true });
    }
    if (a === 'post') {
      const from = String(b.from || ''), text = sanitize(b.text, 1000), fid = String(b.fid || ''), name = sanitize(b.name, 80), rs = String(b.rs || '');
      const cat = ['gaming','sports','music','news','education','faith','entertainment'].includes(String(b.cat || '')) ? String(b.cat) : 'general';
      const dur = Number(b.dur || 0);
      const ts = Math.max(0, Number(b.ts || 0));
      const te = Math.max(0, Number(b.te || 0));
      if (!/^\d{9,12}$/.test(from)) return json({ err: 'invalid' }, 400);
      if (!text && !fid) return json({ err: 'empty post' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const meNode: any = st.nodes.find((n: any) => n.number === from);
      if (!meNode) return json({ err: 'unknown node' }, 403);
      /* v61 (skylar): the old listAll here pulled the ENTIRE settings table (~107MB of
         upload chunks) into the worker and OOM-crashed posting entirely (error 1102).
         Targeted lookups only — posting now stays fast and stable as the table grows. */
      const chanRow: any = await getByKey(db, 'AirConnectSettings', 'chan:' + from);
      if (!/^11\d{8,}$/.test(from) && !chanRow) return json({ err: 'no channel' }, 403);
      {
        const mineRows: any[] = (await listByPrefix(db, 'AirConnectSettings', ['post:' + from + ':'])).filter((r: any) => { const k = String(r.k || ''); return !/:(c\d*|[rv])$/.test(k); });
        let lastAt = 0, lastMin = 0;
        for (const r of mineRows) { let p: any; try { p = JSON.parse(r.v); } catch { continue; } lastAt = Math.max(lastAt, Number(p.at || 0)); if (Date.now() - Number(p.at || 0) < 3600000) lastMin++; }
        if (mineRows.length > 0 && Date.now() - lastAt < 120000 && lastMin >= 20) return json({ err: 'too many posts this hour' }, 429);
      }
      /* video integrity: if a fid is attached, all chunks must be present */
      let fn = 0;
      if (fid) {
        const meta: any = await getByKey(db, 'AirConnectSettings', 'f2:' + fid); /* v61: targeted */
        if (!meta) return json({ err: 'video upload missing' }, 400);
        let m: any; try { m = JSON.parse(meta.v); } catch { return json({ err: 'corrupt upload' }, 403); }
        if (m.from !== from) return json({ err: 'forbidden' }, 403);
        fn = m.n;
      }
      /* auto-channel: every poster gets one, named after them */
      const ck = 'chan:' + from;
      if (!chanRow) {
        try { await db.entities.AirConnectSettings.create({ k: ck, v: JSON.stringify({ num: from, name: sanitize((CNAME as any)[from] || meNode.name || from, 60) + ' · AirConnect', about: 'An AirConnect citizen channel', at: Date.now() }) }); } catch (e) {}
      }
      const id = 'post:' + from + ':' + Date.now();
      try { await db.entities.AirConnectSettings.create({ k: id, v: JSON.stringify({ id, from, ch: from, text, fid, fidn: fn, name, cat, dur, ts, te, at: Date.now(), views: 0, rs: rs && rs.startsWith('post:') ? rs : '' }) }); } catch (e) { return json({ err: 'could not post — try again' }, 503); }
      /* notify subscribers (targeted, v61) */
      try {
        const subRows: any[] = await listByPrefix(db, 'AirConnectSettings', ['sub:']);
        for (const r of subRows) { const m = String(r.k || '').match(/^sub:(\d{9,12}):/); if (m && m[1] !== from) { let sv: any; try { sv = JSON.parse(r.v); } catch { continue; } if (sv[from]) await pushNotify(db, st, m[1], { what: 'chat', from, fromName: meNode.name || 'Someone', text: text ? String(text).slice(0, 60) : '📹 New video' }); } }
      } catch (e) {}
      return json({ ok: true, id });
    }
    if (a === 'wbcast') { /* v73: channel-owner broadcast — one text to every subscriber's chat */
      const from = String(b.from || ''), text = sanitize(b.text || '', 800);
      if (!/^\d{9,12}$/.test(from) || !text) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const chanOwn: any = await getByKey(db, 'AirConnectSettings', 'chan:' + from); /* v62 targeted */
      if (!chanOwn) return json({ err: 'create your channel first' }, 400);
      const rows: any[] = await listByPrefix(db, 'AirConnectSettings', ['sub:']);
      const subs: string[] = [];
      for (const r of rows) {
        const m = String(r.k || '').match(/^sub:(\d{9,12}):/);
        if (m && m[1] !== from) { try { const sv = JSON.parse(r.v); if (sv[from]) subs.push(m[1]); } catch { } }
      }
      if (!subs.length) return json({ err: 'no subscribers yet — post great things and they will come' }, 400);
      const meNode: any = st.nodes.find((n: any) => n.number === from);
      let sent = 0;
      for (const to of subs.slice(0, 200)) {
        if (!st.nodes.find((x: any) => x.number === to)) continue;
        st.msgs.push({ id: rid(), fromNum: from, toNum: to, text, created: new Date().toISOString() });
        try { await db.entities.AirConnectMessage.create({ fromNum: from, toNum: to, text: text.slice(0, 4000) }); } catch (e) { }
        try { await pushNotify(db, st, to, { what: 'chat', from, fromName: meNode ? meNode.name : 'Channel', text: '\uD83D\uDCE3 ' + String(text).slice(0, 60) }); } catch (e) { }
        sent++;
      }
      await saveState(db, st);
      return json({ ok: true, sent, total: subs.length });
    }
    if (a === 'translate') { /* v73 premium: live chat translation */
      const from = String(b.from || ''), text = String(b.text || '').slice(0, 500);
      const to = (sanitize(String(b.to || 'en'), 5).toLowerCase() || 'en');
      if (!/^\d{9,12}$/.test(from) || !text) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const me: any = st.nodes.find((n: any) => n.number === from);
      const act = !!(me && me.premExp && new Date(me.premExp) > new Date());
      const tier = from === '234100000001' ? 'premium' : (act ? String(me.premTier || me.premKind || 'premium').toLowerCase() : '');
      if (!['pro', 'ultra', 'premium'].includes(tier) && !/^11\d{8}$/.test(from)) {
        /* v84: Group Language Plan members translate free inside their paid group */
        let gplan = false;
        const gctx = String((b as any).g || '');
        if (gctx) { const grp: any = (st.groups || []).find((x: any) => x.id === gctx); gplan = !!(grp && (grp.members || []).indexOf(from) >= 0 && grp.gplanExp && new Date(grp.gplanExp) > new Date()); }
        if (!gplan) return json({ err: 'translation is a Pro-plan feature — or ask the group admin to enable the 🌍 Group Language Plan — open 💎 Premium plans in the menu' }, 402);
      }
      const XL_LANGS: any = { en: 'English', yo: 'Yoruba', ig: 'Igbo', ha: 'Hausa', pcm: 'Nigerian Pidgin', tw: 'Twi', zu: 'Zulu', ef: 'Efik', ib: 'Ibibio', fr: 'French', es: 'Spanish', pt: 'Portuguese', ar: 'Arabic', zh: 'Chinese (Mandarin)', hi: 'Hindi', sw: 'Swahili', de: 'German', ru: 'Russian', tr: 'Turkish', am: 'Amharic', so: 'Somali' };
      const tgt = XL_LANGS[to] || 'English';
      const SYSP = 'You are a live translation engine. Translate the user text into ' + tgt + '. Reply with ONLY the translation in ' + tgt + ' — no notes, no quotes, no explanations. If the text is already ' + tgt + ', repeat it unchanged.'; /* v83: citizens (11-prefix) translate for their user internally */
      try {
        let r: any = null;
        try { r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [
          { role: 'system', content: SYSP },
          { role: 'user', content: text }
        ], max_tokens: 300 }); } catch (e: any) { r = null; }
        if (!r) r = await env.AI.run('@cf/meta/llama-3.2-1b-instruct', { messages: [
          { role: 'system', content: SYSP },
          { role: 'user', content: text }
        ], max_tokens: 300 });
        const out = String((r && (r.response || r.text)) || '').trim().replace(/^["']+|["']+$/g, '');
        return json({ ok: true, text: out.slice(0, 500) });
      } catch (e: any) { return json({ err: 'translate unavailable — try again', detail: String(e && e.message || e).slice(0, 200) }, 502); }
    }
    if (a === 'vbadge') { /* v73: owner grants/removes a channel's verified badge */
      const from = String(b.from || ''), aid = String(b.aid || ''), num = String(b.num || ''), on = b.on !== 0 && b.on !== false;
      if (from !== '234100000001') return json({ err: 'not authorized' }, 403);
      const st = await loadState(db);
      const me: any = st.nodes.find((n: any) => n.number === from);
      if (!me || !aid || String(me.aid) !== aid) return json({ err: 'not authorized' }, 403);
      const key = 'vch:' + num; /* v62 targeted */
      const rr: any = await getByKey(db, 'AirConnectSettings', key);
      if (on) { if (!rr) await db.entities.AirConnectSettings.create({ k: key, v: JSON.stringify({ num, at: Date.now() }) }); }
      else if (rr) await delRec(db, 'AirConnectSettings', rr.id);
      return json({ ok: true, on });
    }
    if (a === 'skill') { /* v73 premium: citizen skills marketplace — activate a skill per citizen */
      const from = String(b.from || ''), citizen = String(b.citizen || ''), k = sanitize(b.k || '', 40);
      if (!/^\d{9,12}$/.test(from) || !/^11\d{8}$/.test(citizen)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const me: any = st.nodes.find((n: any) => n.number === from);
      const actS = !!(me && me.premExp && new Date(me.premExp) > new Date());
      const tierS = from === '234100000001' ? 'premium' : (actS ? String(me.premTier || me.premKind || 'premium').toLowerCase() : '');
      if (k && !['ultra', 'premium'].includes(tierS)) return json({ err: 'citizen skills are an Ultra-plan feature — open 💎 Premium plans in the menu' }, 402);
      const key = 'skill:' + from + ':' + citizen;
      const rr: any = await getByKey(db, 'AirConnectSettings', key); /* v62 targeted */
      if (!k) { if (rr) await delRec(db, 'AirConnectSettings', rr.id); return json({ ok: true, k: '' }); }
      if (rr) await updateRec(db, 'AirConnectSettings', rr.id, { v: JSON.stringify({ k, at: Date.now() }) });
      else await db.entities.AirConnectSettings.create({ k: key, v: JSON.stringify({ k, at: Date.now() }) });
      return json({ ok: true, k });
    }
    if (a === 'skills') { /* v73: bridge reads a user's active citizen skills */
      const num = String(b.num || '');
      if (!/^\d{9,12}$/.test(num)) return json({ err: 'invalid' }, 400);
      const rows = await listByPrefix(db, 'AirConnectSettings', ['skill:' + num + ':']);
      const map: any = {};
      for (const r of rows) {
        const m = String(r.k || '').match(/^skill:\d{9,12}:(11\d{8})$/);
        let v: any; try { v = JSON.parse(r.v); } catch { continue; }
        if (m && v && v.k) map[m[1]] = v.k;
      }
      return json({ ok: true, skills: map });
    }
    if (a === 'studio') { /* v73: channel backend — owner sees own posts + views/reactions/comments/subscribers */
      const node = String(b.node || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const rows = await listByPrefix(db, 'AirConnectSettings', ['post:' + node + ':', 'sub:', 'chan:' + node, 'earn:' + node]); /* v62 targeted — studio only touches this channel's data */
      const chanRow: any = rows.find((r: any) => String(r.k || '') === 'chan:' + node);
      let chan: any = null; if (chanRow) { try { chan = JSON.parse(chanRow.v); } catch { chan = null; } }
      let subs = 0;
      for (const r of rows) {
        const m = String(r.k || '').match(/^sub:(\d{9,12}):/);
        if (m && m[1] !== node) { try { const sv = JSON.parse(r.v); if (sv[node]) subs++; } catch { } }
      }
      const mine: any[] = [];
      for (const r of rows) {
        const k = String(r.k || '');
        if (!k.startsWith('post:' + node + ':') || /:(c\d*|[rv])$/.test(k)) continue;
        let p: any; try { p = JSON.parse(r.v); } catch { continue; }
        if (p && p.id) mine.push(p);
      }
      mine.sort((x: any, y: any) => Number(y.at || 0) - Number(x.at || 0));
      const ids = new Set(mine.map((p: any) => p.id));
      const rc: any = {}, vc: any = {}, cc: any = {};
      for (const r of rows) {
        const k = String(r.k || '');
        const m = k.match(/^(post:[^:]+:[^:]+):(c\d*|[rv])$/);
        if (!m || !ids.has(m[1])) continue;
        if (m[2] === 'v') { try { vc[m[1]] = Object.keys(JSON.parse(r.v)).length; } catch { } }
        if (m[2] === 'r') { try { rc[m[1]] = Object.keys(JSON.parse(r.v)).length; } catch { } }
        if (m[2][0] === 'c') { cc[m[1]] = (cc[m[1]] || 0) + 1; }
      }
      let tv = 0, tr = 0, tc = 0;
      const posts = mine.slice(0, 200).map((p: any) => {
        const vcnt = vc[p.id] || 0, rcnt = rc[p.id] || 0, ccnt = cc[p.id] || 0;
        tv += vcnt; tr += rcnt; tc += ccnt;
        return { id: p.id, kind: p.fid ? (p.pic ? 'photo' : (Number(p.dur || 0) >= 300 ? 'long' : 'short')) : 'text', text: String(p.text || '').slice(0, 90), at: p.at, cat: p.cat || 'general', vcnt, rcnt, ccnt, earn: vcnt / 1000 };
      });
      let earnBal = 0;
      try { const er: any = rows.find((x: any) => x.k === 'earn:' + node); if (er) { const e: any = JSON.parse(er.v); earnBal = Number(e.bal || 0); } } catch (e) { }
      const meNode: any = st.nodes.find((n: any) => n.number === node);
      return json({ ok: true, chan: chan ? { name: chan.name, about: chan.about, mon: !!chan.mon } : null, mon: !!(chan && chan.mon), earn: earnBal, payposts: mine.filter((p: any) => p.fid || 1).filter((p: any) => (vc[p.id] || 0) >= 1000).length, cname: (CNAME as any)[node] || (meNode ? meNode.name : node) || node, subs, totals: { posts: mine.length, views: tv, reacts: tr, comments: tc }, posts });
    }
    if (a === 'pget') { /* v60 (skylar): shareable post links — fetch ONE post by its id so a link lands the user directly on it */
      const node = String(b.from || ''), id = String(b.id || '');
      if (!/^\d{9,12}$/.test(node) || !id.startsWith('post:')) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      if (!st.nodes.find((n: any) => n.number === node)) return json({ err: 'unknown node' }, 403);
      /* v61: exact-key fetch — share links never scan the table */
      const row: any = await getByKey(db, 'AirConnectSettings', id);
      if (!row) return json({ err: 'not found' }, 404);
      let p: any; try { p = JSON.parse(row.v); } catch { return json({ err: 'not found' }, 404); }
      if (!p || !p.id || !p.from || String(row.k || '') !== id) return json({ err: 'not found' }, 404);
      const poster: any = st.nodes.find((n: any) => n.number === p.from) || {};
      p.pname = (CNAME as any)[p.from] || poster.name || p.from;
      const chanRow: any = await getByKey(db, 'AirConnectSettings', 'chan:' + String(p.ch || p.from));
      let chname = '';
      if (chanRow) { try { chname = JSON.parse(chanRow.v).name || ''; } catch {} }
      return json({ ok: true, p, chname });
    }

    if (a === 'posts') {
      const node = String(b.node || ''), scope = String(b.scope || 'feed'), ch = String(b.ch || ''), catf = String(b.cat || ''), before = Number(b.before || 0);
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      /* v61: feed only needs post rows, verified marks and subscription rows —
         pulling upload chunks here OOM'd the worker (error 1102). */
      const rows = await listByPrefix(db, 'AirConnectSettings', ['post:', 'vch:', 'sub:']);
      const subs: any = {}; const vset2 = new Set<string>();
      for (const r of rows) { const k = String(r.k || ''); if (k.startsWith('vch:')) { const mm = k.slice(4); if (!/:/.test(mm)) vset2.add(mm); } else if (k.startsWith('sub:' + node + ':')) { let sv: any; try { sv = JSON.parse(r.v); } catch { continue; } Object.assign(subs, sv); } }
      const out: any[] = [];
      for (const r of rows) {
        const k = String(r.k || '');
        if (!k.startsWith('post:') || /:(c\d*|[rv])$/.test(k)) continue;
        let p: any; try { p = JSON.parse(r.v); } catch { continue; }
        if (!p || !p.id || !p.from) continue; /* skip corrupt rows — never let non-post rows become feed items */
        if (before && Number(p.at || 0) >= before) continue;
        /* v67 skylar directive: Feed = written posts only · Shorts = videos under 5 min · Watch = long videos 5 min+ */
        if (scope === 'feed' && p.fid) continue;                                  /* text-only feed */
        if (scope === 'shorts') { if (!p.fid) continue; if (Number(p.dur || 0) >= 300) continue; }
        if (scope === 'watch') { if (!p.fid) continue; if (Number(p.dur || 0) < 300) continue; }
        if (scope === 'catv') { if (!p.fid) continue; if (catf && String(p.cat || 'general') !== catf) continue; }
        if (scope === 'cat' && catf && String(p.cat || 'general') !== catf) continue;
        if (scope === 'ch' && String(p.ch || p.from) !== ch) continue;
        const poster: any = st.nodes.find((n: any) => n.number === p.from) || {};
        p.pname = (CNAME as any)[p.from] || poster.name || p.from;
        if ((CNAME as any)[p.from] && String(p.name || '').startsWith('Citizen')) p.name = 'AirConnect Citizen';
        p.mysub = !!subs[String(p.ch || p.from)];
        p.v = vset2.has(String(p.ch || p.from));
        out.push(p);
      }
      /* v119 (skylar correction of v82): NO FAKE VIEW COUNTS — views shown must always be real.
         Promotion now works purely on ORDERING: an active plan subscriber's post is boosted to the
         top of the feed (after the owner) ONLY while it has fewer than 150 REAL views; the moment a
         promoted post's genuine view count reaches 150, its promotion ends and it drops to the normal
         tier (sorted by recency with everyone else) so OTHER still-building promoted posts surface first. */
      const idMap: any = {};
      for (const p of out) idMap[p.id] = p;
      for (const r of rows) {
        const k = String(r.k || '');
        const m = k.match(/^(post:[^:]+:[^:]+):(c\d*|[rv])$/);
        if (!m || !idMap[m[1]]) continue;
        const p: any = idMap[m[1]];
        if (m[2] === 'v') { let v: any; try { v = JSON.parse(r.v); } catch { v = {}; } p.vcnt = Object.keys(v).length; }
        if (m[2] === 'r') { let v: any; try { v = JSON.parse(r.v); } catch { v = {}; } const rc: any = {}; for (const kk of Object.keys(v)) rc[v[kk]] = (rc[v[kk]] || 0) + 1; p.reacts = rc; p.myreact = v[node] || ''; }
        if (m[2][0] === 'c') { p.ccnt = (p.ccnt || 0) + 1; }
      }
      for (const p of out) { if (p.vcnt === undefined) p.vcnt = 0; if (!p.reacts) p.reacts = {}; if (p.ccnt === undefined) p.ccnt = 0; }
      const actSub: any = {};
      for (const n of st.nodes) { if (n.number === '234100000001' || (n.premExp && new Date(n.premExp) > new Date())) actSub[n.number] = 1; }
      const isPromoted = (p: any) => p.from !== '234100000001' && actSub[p.from] && (Date.now() - Number(p.at || 0)) < 31 * 86400000 && Number(p.vcnt || 0) < 150;
      out.sort((x: any, y: any) => {
        const kx = x.from === '234100000001' ? 0 : (isPromoted(x) ? 1 : 2);
        const ky = y.from === '234100000001' ? 0 : (isPromoted(y) ? 1 : 2);
        if (kx !== ky) return kx - ky;
        return Number(y.at || 0) - Number(x.at || 0);
      });
      const page = out.slice(0, 30);
      return json({ ok: true, posts: page, more: out.length > 30 });
    }
    if (a === 'pcomments') {
      const node = String(b.node || ''), id = String(b.id || '');
      if (!/^\d{9,12}$/.test(node) || !id.startsWith('post:')) return json({ err: 'invalid' }, 400);
      const cRows: any[] = await listByPrefix(db, 'AirConnectSettings', [id + ':c']); /* v61: targeted */
      const cs = cRows.map((r: any) => { let c: any; try { c = JSON.parse(r.v); } catch { c = {}; } return c; }).sort((x: any, y: any) => Number(x.at || 0) - Number(y.at || 0));
      return json({ ok: true, comments: cs.slice(0, 200) });
    }
    if (a === 'pcomment') {
      const from = String(b.from || ''), id = String(b.id || ''), text = sanitize(b.text, 300);
      if (!/^\d{9,12}$/.test(from) || !id.startsWith('post:') || !text) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const meNode: any = st.nodes.find((n: any) => n.number === from);
      if (!(await getByKey(db, 'AirConnectSettings', id))) return json({ err: 'post not found' }, 404); /* v61: targeted */
      const n = (await listByPrefix(db, 'AirConnectSettings', [id + ':c'])).length;
      if (n >= 200) return json({ err: 'comment limit reached' }, 429);
      await db.entities.AirConnectSettings.create({ k: id + ':c' + n, v: JSON.stringify({ from, name: (CNAME as any)[from] || (meNode ? meNode.name : from), text, at: Date.now() }) });
      return json({ ok: true, n: n + 1 });
    }
    if (a === 'preact') {
      const from = String(b.from || ''), id = String(b.id || ''), r = String(b.r || '');
      if (!/^\d{9,12}$/.test(from) || !id.startsWith('post:')) return json({ err: 'invalid' }, 400);
      if (!['👍', '❤️', '😂', '😮', '🙏', '🔥', ''].includes(r)) return json({ err: 'bad reaction' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      if (!(await getByKey(db, 'AirConnectSettings', id))) return json({ err: 'post not found' }, 404); /* v61: targeted */
      const rk = id + ':r';
      let cur: any = await getByKey(db, 'AirConnectSettings', rk);
      let map: any = {}; try { map = cur ? JSON.parse(cur.v) : {}; } catch { map = {}; }
      if (r === '') delete map[from]; else map[from] = r;
      if (cur) await updateRec(db, 'AirConnectSettings', cur.id, { v: JSON.stringify(map) });
      else await db.entities.AirConnectSettings.create({ k: rk, v: JSON.stringify(map) });
      const rc: any = {}; for (const kk of Object.keys(map)) rc[map[kk]] = (rc[map[kk]] || 0) + 1;
      return json({ ok: true, reacts: rc, mine: r });
    }
    if (a === 'pview') {
      const from = String(b.from || ''), id = String(b.id || '');
      if (!/^\d{9,12}$/.test(from) || !id.startsWith('post:')) return json({ err: 'invalid' }, 400);
      if (!(await getByKey(db, 'AirConnectSettings', id))) return json({ err: 'post not found' }, 404); /* v61: targeted */
      const vk = id + ':v';
      let cur: any = await getByKey(db, 'AirConnectSettings', vk);
      let map: any = {}; try { map = cur ? JSON.parse(cur.v) : {}; } catch { map = {}; }
      if (map[from]) return json({ ok: true, n: Object.keys(map).length });
      map[from] = 1;
      if (cur) await updateRec(db, 'AirConnectSettings', cur.id, { v: JSON.stringify(map) });
      else await db.entities.AirConnectSettings.create({ k: vk, v: JSON.stringify(map) });
      const nv = Object.keys(map).length;
      /* v78 PAY-POST (skylar directive): a monetized channel earns $1 each time a SINGLE POST crosses a new 1,000-view milestone — credited instantly */
      if (nv > 0 && nv % 1000 === 0) {
        try {
          const pr: any = await getByKey(db, 'AirConnectSettings', id);
          let p: any = {}; try { p = pr ? JSON.parse(pr.v) : {}; } catch { p = {}; }
          const owner = String(p.ch || p.from || '');
          const chRow: any = await getByKey(db, 'AirConnectSettings', 'chan:' + owner);
          let ch: any = null; if (chRow) { try { ch = JSON.parse(chRow.v); } catch { ch = null; } }
          if (owner && ch && ch.mon) {
            const er: any = await getByKey(db, 'AirConnectSettings', 'earn:' + owner);
            let e: any = {}; try { e = er ? JSON.parse(er.v) : {}; } catch { e = {}; }
            e.bal = Number(e.bal || 0) + 1;
            e.txns = (e.txns || []).concat([{ id: id + ':' + nv, post: id, views: nv, usd: 1, at: Date.now() }]).slice(-100);
            if (er) await updateRec(db, 'AirConnectSettings', er.id, { v: JSON.stringify(e) });
            else await db.entities.AirConnectSettings.create({ k: 'earn:' + owner, v: JSON.stringify(e) });
            /* v79: one unified wallet — the $1 pay-post credit lands in the ₦ wallet instantly at ₦1,600/$ */
            try { const wb = await walGet(db, owner); await walSet(db, owner, wb + 1600, undefined); } catch (e2) { }
            try { const stN: any = await loadState(db); await pushNotify(db, stN, owner, { what: 'chat', from: owner, fromName: 'AirConnect', text: '\uD83D\uDCB0 PAY POST! ' + nv.toLocaleString() + ' views \u2014 $1 (\u20A61,600) credited to your wallet' }); } catch (e2) { }
          }
        } catch (e) { }
      }
      return json({ ok: true, n: nv });
    }
    if (a === 'postdel') {
      const from = String(b.from || ''), id = String(b.id || '');
      if (!/^\d{9,12}$/.test(from) || !id.startsWith('post:' + from + ':')) return json({ err: 'invalid' }, 400);
      const rows = await listByPrefix(db, 'AirConnectSettings', [id]); /* v62 targeted */
      await purgeByPrefix(db, 'AirConnectSettings', rows, (k: string) => k === id || k.startsWith(id + ':'));
      return json({ ok: true });
    }

    /* ============ v40: WALLET (user-to-user money, tips, marketplace) ============ */
    async function walGet(db2: any, num: string): Promise<number> {
      const r: any = await getByKey(db2, 'AirConnectSettings', 'wal:' + num); /* v62 targeted */
      let m: any = {}; try { m = r ? JSON.parse(r.v) : {}; } catch { m = {}; }
      return Number(m.bal || 0);
    }
    async function walSet(db2: any, num: string, bal: number, rid: string|undefined) {
      const r: any = await getByKey(db2, 'AirConnectSettings', 'wal:' + num); /* v62 targeted */
      if (r) await updateRec(db2, 'AirConnectSettings', r.id, { v: JSON.stringify({ bal, ts: Date.now() }) });
      else await db2.entities.AirConnectSettings.create({ k: 'wal:' + num, v: JSON.stringify({ bal, ts: Date.now() }) });
    }
    if (a === 'wbal') {
      const node = String(b.node || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const bal = await walGet(db, node);
      const rows = await listByPrefix(db, 'AirConnectSettings', ['wt:']); /* v62 targeted — wallet history rows only */
      const hist: any[] = [];
      for (const r of rows) {
        const k = String(r.k || '');
        if (!k.startsWith('wt:')) continue;
        let t: any; try { t = JSON.parse(r.v); } catch { continue; }
        if (t.from === node || t.to === node) hist.push(t);
      }
      hist.sort((x: any, y: any) => Number(y.at || 0) - Number(x.at || 0));
      return json({ ok: true, bal, hist: hist.slice(0, 20) });
    }
    if (a === 'wsend') {
      const from = String(b.from || ''), to = String(b.to || ''), note = sanitize(b.note, 80);
      const amt = Number(b.amt || 0);
      if (!/^\d{9,12}$/.test(from) || !/^\d{9,12}$/.test(to)) return json({ err: 'invalid' }, 400);
      if (from === to) return json({ err: 'cannot send to yourself' }, 400);
      if (!Number.isInteger(amt) || amt < 1 || amt > 500000) return json({ err: 'amount must be ₦1 – ₦500,000' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      if (!st.nodes.find((n: any) => n.number === to)) return json({ err: 'recipient not on AirConnect' }, 404);
      const bal = await walGet(db, from);
      if (bal < amt) return json({ err: 'insufficient balance' }, 402);
      const b2 = await walGet(db, from);
      if (b2 < amt) return json({ err: 'insufficient balance' }, 402);
      await walSet(db, from, b2 - amt);
      const b3 = await walGet(db, to);
      await walSet(db, to, b3 + amt);
      const id = 'wt:' + Date.now() + ':' + from;
      const txn = { id, from, to, amt, note, at: Date.now() };
      await db.entities.AirConnectSettings.create({ k: id, v: JSON.stringify(txn) });
      try {
        const meNode: any = st.nodes.find((n: any) => n.number === from);
        await pushNotify(db, st, to, { what: 'chat', from, fromName: meNode ? meNode.name : 'Someone', text: '💰 You received ₦' + amt.toLocaleString() });
      } catch (e) { }
      return json({ ok: true, bal: b2 - amt, txn });
    }
    if (a === 'wtopup') {
      const node = String(b.node || ''), amt = Number(b.amt || 0);
      if (!/^\d{9,12}$/.test(node) || !Number.isInteger(amt) || amt < 100 || amt > 500000) return json({ err: 'invalid top-up (₦100 – ₦500,000)' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const now = Date.now();
      const id = 'wclaim:' + node + ':' + now;
      const fid = String(b.fid || '').slice(0, 64);
      const rcp = sanitize(b.rcp || '', 60);
      const ref = 'WAL-' + String(now).slice(-6);
      const gid = sanitize(b.gid || '', 24); /* v57 (skylar): T1 plan claims carry the group id */
      const txn = sanitize(b.txn || '', 24); /* v57 (skylar): typed transaction number for auto-activation */
      await db.entities.AirConnectSettings.create({ k: id, v: JSON.stringify({ num: node, amt, at: now, ref, fid, rcp, gid, txn }) });
      try { await pushNotify(db, st, '234100000001', { what: 'chat', from: node, fromName: 'Wallet claim', text: '💰 Top-up claim ₦' + amt.toLocaleString() + ' from ' + node }); } catch (e) { }
      return json({ ok: true, ref });
    }
    /* v56: reassemble a chunked f2 upload into one base64 string, server-side (used by the receipt auto-check) */
    async function f2Reassemble(db2: any, fid: string): Promise<string> {
      // v65: targeted key/prefix lookups instead of a full settings-table scan
      const meta: any = await getByKey(db2, 'AirConnectSettings', 'f2:' + fid);
      if (!meta) return '';
      let m: any; try { m = JSON.parse(meta.v); } catch { return ''; }
      const chunkRows = await listByPrefix(db2, 'AirConnectSettings', ['f2:' + fid + ':c']);
      const byIdx = new Map<number, string>();
      for (const r of chunkRows) {
        const mm = /:c(\d+)$/.exec(String(r.k || ''));
        if (mm) byIdx.set(Number(mm[1]), String(r.v));
      }
      const parts: string[] = [];
      for (let i = 0; i < m.n; i++) {
        const v = byIdx.get(i);
        if (v === undefined) return '';
        parts.push(v);
      }
      return parts.join('');
    }
    /* v56: ask Workers AI vision (llava, on skylar's own Cloudflare — zero Base44 cost) whether an
       uploaded image looks like a genuine payment receipt/transfer proof, and for how much. */
    async function receiptLooksGenuine(b64: string, amt: number): Promise<{ ok: boolean; note: string }> {
      try {
        const raw = b64.startsWith('data:') ? b64.split(',')[1] : b64;
        const bin = Uint8Array.from(atob(raw.slice(0, 600000)), (ch: string) => ch.charCodeAt(0));
        const r: any = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
          image: [...bin],
          prompt: 'This should be a screenshot or photo of a bank transfer / payment receipt for approximately ' + amt + ' naira. Answer starting with YES or NO: does this image genuinely show a completed bank transfer, payment confirmation, or transaction receipt (not a blank image, random photo, or unrelated screenshot)?',
          max_tokens: 60
        });
        const txt = String(r?.description || r?.response || r?.short_answer || '').trim();
        const yes = /^\s*yes\b/i.test(txt) || /\byes\b/i.test(txt.slice(0, 20));
        return { ok: yes, note: txt.slice(0, 200) };
      } catch (e: any) { return { ok: false, note: 'vision check error: ' + String(e && e.message || e).slice(0, 150) }; }
    }
    /* v56: shared activation — credits the wallet, marks the claim, notifies the buyer. Used by
       both the owner Admin dashboard (manual) and the auto-check below (automatic). */
    async function activateClaim(db2: any, row: any, claimObj: any, note: string, auto: boolean) {
      const to = claimObj.num, amt = Number(claimObj.amt || 0);
      const bal = await walGet(db2, to);
      await walSet(db2, to, bal + amt);
      const id = 'wt:' + Date.now() + ':' + (auto ? 'auto' : 'admin');
      await db2.entities.AirConnectSettings.create({ k: id, v: JSON.stringify({ id, from: 'admin', to, amt, note, at: Date.now() }) });
      await db2.entities.AirConnectSettings.update(row.id, { k: row.k, v: JSON.stringify({ ...claimObj, activated: true, activatedAt: Date.now(), autoActivated: !!auto }) });
      try { const st2 = await loadState(db2); await pushNotify(db2, st2, to, { what: 'chat', from: 'admin', fromName: 'AirConnect', text: '✅ ' + note + ' — ₦' + amt.toLocaleString() + ' credited to your wallet. It is now active.' }); } catch (e) { }
    }
    /* v57 (skylar): REAL plan auto-activation — T1 sets the group Language Plan (grp.gplanExp),
       P1-P4 set the node's premium tier + expiry. NEVER touches the wallet. */
    async function activatePlan(db2: any, row: any, claimObj: any, P: any, planId: string) {
      const st: any = await loadState(db2);
      const buyer = String(claimObj.num || '');
      if (P.kind === 'gplan') {
        const gid = String(claimObj.gid || '');
        const grp: any = st.groups.find((g: any) => g.id === gid);
        if (!grp) return; /* group vanished — leave pending for owner review */
        grp.gplanExp = new Date(Date.now() + P.days * 86400000).toISOString();
        await saveState(db2, st);
        const noteG = '🌍 Group Language Plan ACTIVE for ' + grp.name + ' — group calls and messages now translate for every member';
        try { await pushNotify(db2, st, buyer, { what: 'chat', from: buyer, fromName: 'AirConnect', text: '✅ ' + noteG }); } catch (e: any) {}
        try { await pushNotify(db2, st, String(grp.by), { what: 'chat', from: grp.by, fromName: 'AirConnect', text: '✅ ' + noteG + ' — paid by +' + buyer }); } catch (e: any) {}
      } else {
        const me: any = st.nodes.find((n: any) => n.number === buyer);
        if (!me) return;
        me.premExp = new Date(Date.now() + P.days * 86400000).toISOString();
        me.premTier = P.tier;
        await saveState(db2, st);
        const noteT = '💎 ' + planId + ' plan ACTIVE — your ' + P.tier + ' features are unlocked for ' + P.days + ' days. Thank you!';
        try { await pushNotify(db2, st, buyer, { what: 'chat', from: buyer, fromName: 'AirConnect', text: '✅ ' + noteT }); } catch (e: any) {}
      }
      await db2.entities.AirConnectSettings.update(row.id, { k: row.k, v: JSON.stringify({ ...claimObj, activated: true, activatedAt: Date.now(), autoActivated: true, plan: planId }) });
    }
    const PLANS57: any = { T1: { amt: 4800, kind: 'gplan', days: 30 }, P1: { amt: 4800, kind: 'tier', tier: 'beginner', days: 30 }, P2: { amt: 12800, kind: 'tier', tier: 'pro', days: 30 }, P3: { amt: 24000, kind: 'tier', tier: 'ultra', days: 30 }, P4: { amt: 40000, kind: 'tier', tier: 'premium', days: 30 } };
    if (a === 'wrcpt') {
      const node = String(b.node || ''), fid = String(b.fid || '').slice(0, 64), rcp = sanitize(b.rcp || '', 60);
      if (!/^\d{9,12}$/.test(node) || !fid) return json({ err: 'invalid' }, 400);
      // v65: targeted prefix lookup (only this node's wclaim rows) instead of a full settings-table scan
      const claimRowsForNode = await listByPrefix(db, 'AirConnectSettings', ['wclaim:' + node + ':']);
      const claims = claimRowsForNode
        .map((r: any) => { let p: any; try { p = JSON.parse(r.v); } catch { return null; } return p ? { row: r, p } : null; }).filter(Boolean)
        .sort((x: any, y: any) => Number(y.p.at || 0) - Number(x.p.at || 0));
      const target = claims.find((c: any) => !c.p.fid);
      if (!target) return json({ err: 'no pending claim' }, 404);
      const updated = { ...target.p, fid, rcp };
      await db.entities.AirConnectSettings.update(target.row.id, { k: target.row.k, v: JSON.stringify(updated) });
      /* v56: auto-check the receipt with vision AI right away — activate automatically when it
         genuinely looks like a matching payment receipt; otherwise leave it pending for the owner. */
      let autoNote = '';
      try {
        const b64 = await f2Reassemble(db, fid);
        if (b64) {
          const amt = Number(target.p.amt || 0);
          const day = new Date().toISOString().slice(0, 10);
          const h = await shaHex(String(b64).slice(0, 600000));
          // v65: targeted key lookups instead of two more full settings-table scans
          const hashRow = await getByKey(db, 'AirConnectSettings', 'whash:' + h);
          const cntKey = 'wauto:' + node + ':' + day;
          const cntRow = await getByKey(db, 'AirConnectSettings', cntKey);
          const cnt = cntRow ? Number(JSON.parse(cntRow.v).n || 0) : 0;
          const pidm = /^PLAN (T1|P1|P2|P3|P4)/.exec(String(updated.rcp || ''));
          if (pidm) {
            /* v57 (skylar): plan purchases auto-activate ONLY when ALL FOUR checks pass:
               exact plan price on the claim, receipt uploaded within 30 minutes of the claim,
               vision AI confirms a genuine payment receipt, and the typed transaction number
               matches the reference printed on the receipt. Otherwise it stays pending for
               the owner. The wallet is NEVER credited for a plan purchase. */
            const P = PLANS57[pidm[1]];
            const within30 = Date.now() - Number(target.p.at || 0) <= 30 * 60 * 1000;
            const txn = String(updated.txn || target.p.txn || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            if (!P || Number(target.p.amt || 0) !== P.amt) { autoNote = ' — plan price mismatch on claim ' + (target.p.ref || '') + ', awaiting your review 🚩'; }
            else if (hashRow) { autoNote = ' — duplicate receipt detected, awaiting your review 🚩'; }
            else if (cnt >= 3) { autoNote = ' — daily auto-verify limit (3) reached, awaiting your review'; }
            else if (!within30) { autoNote = ' — submitted outside the 30-minute payment window, awaiting your review'; }
            else if (txn.length < 4) { autoNote = ' — no transaction number on the claim, awaiting your review'; }
            else {
              const check = await receiptLooksGenuine(b64, P.amt);
              let txnOk = false, seen = '';
              if (check.ok) {
                try {
                  const raw = b64.startsWith('data:') ? b64.split(',')[1] : b64;
                  const bin = Uint8Array.from(atob(raw.slice(0, 600000)), (ch: string) => ch.charCodeAt(0));
                  const txr: any = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', { image: [...bin], prompt: 'Read this payment receipt and output ONLY the transaction reference / reference number / session ID exactly as printed. If none is visible, output NONE.', max_tokens: 40 });
                  seen = String((txr && txr.response) || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                  txnOk = seen.length >= 4 && seen !== 'NONE' && (seen.indexOf(txn) >= 0 || txn.indexOf(seen) >= 0);
                } catch (e: any) { txnOk = false; }
              }
              if (!check.ok) { autoNote = ' — AI check inconclusive (' + check.note + '), awaiting your review'; }
              else if (!txnOk) { autoNote = ' — transaction number not confirmed (claim has ' + txn + ', receipt reads ' + (seen || 'nothing') + '), awaiting your review 🚩'; }
              else {
                await activatePlan(db, target.row, updated, P, pidm[1]);
                await db.entities.AirConnectSettings.create({ k: 'whash:' + h, v: JSON.stringify({ at: Date.now(), node }) });
                await db.entities.AirConnectSettings.create({ k: cntKey, v: JSON.stringify({ n: cnt + 1 }) });
                autoNote = ' — ' + pidm[1] + ' plan auto-verified and activated ✅';
              }
            }
          }
          else if (hashRow) { autoNote = ' — duplicate receipt detected, awaiting your review 🚩'; }
          else if (amt > 20000) { autoNote = ' — amount above auto-verify limit (₦20,000), awaiting your review'; }
          else if (cnt >= 3) { autoNote = ' — daily auto-verify limit (3) reached, awaiting your review'; }
          else {
            const check = await receiptLooksGenuine(b64, amt);
            if (check.ok) {
              await activateClaim(db, target.row, updated, 'Wallet top-up ' + (target.p.ref || '') + ' auto-verified', true);
              await db.entities.AirConnectSettings.create({ k: 'whash:' + h, v: JSON.stringify({ at: Date.now(), node }) });
              await db.entities.AirConnectSettings.create({ k: cntKey, v: JSON.stringify({ n: cnt + 1 }) });
              autoNote = ' — AI auto-verified and activated ✅';
            } else { autoNote = ' — AI check inconclusive (' + check.note + '), awaiting your review'; }
          }
        }
        /* v159 (skylar): PAYMENT NAME VERIFICATION — the vision AI reads the real sender/payer
           name printed on the bank receipt, cross-checks it against the profile's registered name,
           records the result on the claim, and (on a match) stores it as the user's payment-verified
           identity — which whois/the AI receptionist then prefer over any self-typed name. */
        try {
          let stR: any = null; try { stR = await loadState(db); } catch (e) { }
          const raw = b64.startsWith('data:') ? b64.split(',')[1] : b64;
          const bin = Uint8Array.from(atob(raw.slice(0, 600000)), (ch: string) => ch.charCodeAt(0));
          const nr: any = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', { image: [...bin], prompt: 'Read this payment receipt and output ONLY the sender/payer account name exactly as printed (the person who SENT the money). If none is visible, output NONE.', max_tokens: 60 });
          let vname = String((nr && (nr.response || nr.description || nr.short_answer)) || '').trim();
          if (/^(none|n\/a|unknown|no name)$/i.test(vname) || vname.length < 2) vname = '';
          vname = sanitize(vname, 60);
          if (vname) {
            const meN: any = stR ? stR.nodes.find((n: any) => n.number === node) : null;
            const reg = String((meN && meN.name) || '');
            const toks = (x: string) => x.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w: string) => w.length >= 3);
            const vt = toks(vname), rt = toks(reg);
            const vmatch = !!reg && (vt.some((w: string) => rt.indexOf(w) >= 0) || vname.toLowerCase().indexOf(reg.toLowerCase()) >= 0 || reg.toLowerCase().indexOf(vname.toLowerCase()) >= 0);
            const curRow: any = await getByKey(db, 'AirConnectSettings', target.row.k); /* re-read: the claim may have just been auto-activated — never clobber those fields */
            let curP: any = updated; try { if (curRow) curP = JSON.parse(curRow.v); } catch (e) { curP = updated; }
            await db.entities.AirConnectSettings.update(target.row.id, { k: target.row.k, v: JSON.stringify({ ...curP, vname, vmatch, vnameAt: Date.now() }) });
            if (vmatch) {
              const vkey = 'vname:' + node;
              const oldV: any = await getByKey(db, 'AirConnectSettings', vkey);
              const vv = JSON.stringify({ name: vname, at: Date.now() });
              if (oldV) await db.entities.AirConnectSettings.update(oldV.id, { k: vkey, v: vv });
              else await db.entities.AirConnectSettings.create({ k: vkey, v: vv });
              autoNote = autoNote + ' — payment name "' + vname + '" matches profile ✓';
            } else {
              autoNote = autoNote + ' — receipt payer "' + vname + '" ≠ profile "' + (reg || '(none)') + '" (may be a business account or someone else paying — review in claims)';
            }
          }
        } catch (e: any) { }
      } catch (e: any) { autoNote = ' — auto-check failed, awaiting your review'; }
      try { await pushNotify(db, await loadState(db), '234100000001', { what: 'chat', from: node, fromName: 'Wallet receipt', text: '🧾 Receipt uploaded for claim ' + target.p.ref + ' (₦' + Number(target.p.amt || 0).toLocaleString() + ') from ' + node + autoNote }); } catch (e) { }
      return json({ ok: true, ref: target.p.ref });
    }
    if (a === 'wautocheck') {
      /* v56: owner-triggered re-run of the AI receipt check on a specific pending claim (Admin dashboard 🤖 button) */
      const by = String(b.by || ''), aid = String(b.aid || ''), tk = String(b.tk || '');
      const ADMIN_NUM2 = '234100000001';
      const tkOk = tk && tk === String(env.ADMIN_TK || 'air-unban-2026');
      const st0 = await loadState(db);
      if (!tkOk) {
        const me: any = st0.nodes.find((n: any) => n.number === by);
        if (by !== ADMIN_NUM2 || !me || !me.aid || String(aid) !== String(me.aid)) return json({ err: 'forbidden' }, 403);
      }
      const ck = String(b.claim || '');
      if (!ck.startsWith('wclaim:')) return json({ err: 'invalid' }, 400);
      // v65: targeted key lookup instead of a full settings-table scan
      const row: any = await getByKey(db, 'AirConnectSettings', ck);
      if (!row) return json({ err: 'not found' }, 404);
      let p: any; try { p = JSON.parse(row.v); } catch { return json({ err: 'corrupt' }, 400); }
      if (p.activated || p.rejected) return json({ err: 'already resolved' }, 400);
      if (!p.fid) return json({ err: 'no receipt uploaded yet' }, 400);
      const b64 = await f2Reassemble(db, p.fid);
      if (!b64) return json({ err: 'could not read receipt image' }, 500);
      const check = await receiptLooksGenuine(b64, Number(p.amt || 0));
      if (check.ok) {
        const pidm2 = /^PLAN (T1|P1|P2|P3|P4)/.exec(String(p.rcp || ''));
        if (pidm2) { const P2x = PLANS57[pidm2[1]]; await activatePlan(db, row, p, P2x, pidm2[1]); return json({ ok: true, activated: true, note: pidm2[1] + ' plan activated' }); }
        await activateClaim(db, row, p, 'Wallet top-up ' + (p.ref || '') + ' auto-verified', true); return json({ ok: true, activated: true, note: check.note });
      }
      return json({ ok: true, activated: false, note: check.note });
    }
    /* ---------- v43: OWNER WALLET ADMIN — claims + receipts, manual activation ---------- */
    const ADMIN_NUM = '234100000001';
    if (a === 'wclaims') {
      const by = String(b.by || ''), aid = String(b.aid || ''), tk = String(b.tk || '');
      const tkOk = tk && tk === String(env.ADMIN_TK || 'air-unban-2026');
      const st = await loadState(db);
      if (!tkOk) {
        const me: any = st.nodes.find((n: any) => n.number === by);
        if (by !== ADMIN_NUM || !me || !me.aid || String(aid) !== String(me.aid)) return json({ err: 'forbidden' }, 403);
      }
      // v65: targeted prefix fetch — was a full listAll() scan of the WHOLE settings
      // table (which also holds every f2 video/receipt base64 chunk, up to ~44MB per
      // video) on every admin-dashboard load; that routinely blew CPU/response limits
      // and surfaced to skylar as "Could not load claims." Now pulls only wclaim:/wt: rows.
      const claimRows = await listByPrefix(db, 'AirConnectSettings', ['wclaim:']);
      const claims: any[] = [];
      for (const r of claimRows) {
        const k = String(r.k || '');
        let c: any; try { c = JSON.parse(r.v); } catch { continue; }
        const u: any = st.nodes.find((n: any) => n.number === c.num) || {};
        claims.push({ k, num: c.num, name: u.name || '', amt: c.amt, ref: c.ref, fid: c.fid || '', rcp: c.rcp || '', at: c.at, activated: !!c.activated, rejected: !!c.rejected, doneAt: c.activatedAt || c.rejectedAt || 0 });
      }
      claims.sort((a2: any, b2: any) => b2.at - a2.at);
      const txRows = await listByPrefix(db, 'AirConnectSettings', ['wt:']);
      const tx: any[] = [];
      for (const r of txRows) {
        let t: any; try { t = JSON.parse(r.v); } catch { continue; }
        tx.push({ from: t.from, to: t.to, amt: t.amt, note: t.note, at: t.at });
      }
      tx.sort((a2: any, b2: any) => b2.at - a2.at);
      tx.splice(60);
      return json({ ok: true, claims, tx });
    }
    if (a === 'wconfirm') {
      const by = String(b.by || ''), aid = String(b.aid || ''), tk = String(b.tk || '');
      const tkOk = tk && tk === String(env.ADMIN_TK || 'air-unban-2026');
      const st = await loadState(db);
      if (!tkOk) {
        const me: any = st.nodes.find((n: any) => n.number === by);
        if (by !== ADMIN_NUM || !me || !me.aid || String(aid) !== String(me.aid)) return json({ err: 'forbidden' }, 403);
      }
      if (b.claim) { /* v56: mark a claim activated/rejected — kept in history for the admin dashboard, never deleted */
        const ck = String(b.claim);
        if (!ck.startsWith('wclaim:')) return json({ err: 'invalid' }, 400);
        // v65: targeted key lookup instead of a full settings-table scan
        const row: any = await getByKey(db, 'AirConnectSettings', ck);
        if (row) {
          let cp: any = {}; try { cp = JSON.parse(row.v); } catch {}
          const pidm3 = /^PLAN (T1|P1|P2|P3|P4)/.exec(String(cp.rcp || ''));
          if (b.reject) cp = { ...cp, rejected: true, rejectedAt: Date.now() };
          else {
            cp = { ...cp, activated: true, activatedAt: Date.now() };
            /* v57 (skylar): owner manual Activate on a PLAN claim activates the real plan, not just the record */
            if (pidm3 && !cp.plan) { const P3x = PLANS57[pidm3[1]]; await activatePlan(db, row, cp, P3x, pidm3[1]); return json({ ok: true, cleared: ck, plan: pidm3[1] }); }
          }
          await db.entities.AirConnectSettings.update(row.id, { k: row.k, v: JSON.stringify(cp) });
        }
        return json({ ok: true, cleared: ck });
      }
      const to = String(b.to || ''), amt = Number(b.amt || 0);
      if (!/^\d{9,12}$/.test(to) || !Number.isInteger(amt) || amt < -500000 || amt > 500000) return json({ err: 'invalid' }, 400);
      const bal = await walGet(db, to);
      await walSet(db, to, bal + amt);
      const id = 'wt:' + Date.now() + ':admin';
      const noteTxt = sanitize(b.note || 'owner manual activation', 80);
      await db.entities.AirConnectSettings.create({ k: id, v: JSON.stringify({ id, from: 'admin', to, amt, note: noteTxt, at: Date.now() }) });
      try { await pushNotify(db, st, to, { what: 'chat', from: 'admin', fromName: 'AirConnect', text: '✅ ' + noteTxt + ' — ₦' + amt.toLocaleString() + ' credited to your wallet. It is now active.' }); } catch (e) {}
      return json({ ok: true, bal: bal + amt });
    }

    if (a === 'wadmin') {
      if (String(b.tk || '') !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      const to = String(b.to || ''), amt = Number(b.amt || 0);
      if (!/^\d{9,12}$/.test(to) || !Number.isInteger(amt)) return json({ err: 'invalid' }, 400);
      const bal = await walGet(db, to);
      await walSet(db, to, bal + amt);
      const id = 'wt:' + Date.now() + ':admin';
      await db.entities.AirConnectSettings.create({ k: id, v: JSON.stringify({ id, from: 'admin', to, amt, note: sanitize(b.note || 'verified top-up', 80), at: Date.now() }) });
      return json({ ok: true, bal: bal + amt });
    }
    /* ============ v40: AI VOICE + TEXT TRANSLATION ============ */
    if (a === 'vtr') {
      const node = String(b.node || ''), lang = sanitize(b.lang, 30) || 'English';
      const text0 = String(b.text || '');
      let audio = String(b.audio || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const meT: any = st.nodes.find((n: any) => n.number === node);
      const act2 = !!(meT && meT.premExp && new Date(meT.premExp) > new Date());
      const tier2 = node === '234100000001' ? 'premium' : (act2 ? String(meT.premTier || meT.premKind || 'premium').toLowerCase() : '');
      if (!['pro', 'ultra', 'premium'].includes(tier2)) return json({ err: 'translation is a Pro-plan feature — open 💎 Premium plans in the menu' }, 402);
      let src = text0;
      let detected = '';
      if (audio) {
        if (!audio.startsWith('data:audio/') || audio.length > 1600000) return json({ err: 'bad audio' }, 400);
        const comma = audio.indexOf(',');
        const head = audio.slice(5, comma);
        const mime = (head.split(';')[0] || 'audio/webm');
        const bytes = Uint8Array.from(atob(audio.slice(comma + 1)), (c) => c.charCodeAt(0));
        const ext = mime.includes('mp4') ? 'mp4' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : 'webm';
        const fd = new FormData();
        fd.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), 'vnote.' + ext);
        fd.append('model_id', 'scribe_v1');
        fd.append('diarize', 'false');
        const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': XI_KEY }, body: fd });
        const txt = await r.text();
        let out: any = {}; try { out = JSON.parse(txt); } catch { out = {}; }
        if (!r.ok) return json({ err: 'stt upstream ' + r.status }, 502);
        src = String(out.text ?? out.transcription ?? '');
        detected = out.language_code || '';
        if (!src.trim()) return json({ err: 'nothing spoken detected' }, 400);
      }
      if (!src.trim()) return json({ err: 'nothing to translate' }, 400);
      let result = src;
      try {
        const ai = (env as any).AI;
        const r2 = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: 'You are a universal translator covering every language in the world, including local and regional languages (Yoruba, Igbo, Hausa, Nigerian Pidgin, Swahili, Twi, Zulu, Efik, Ibibio, Tiv, Kanuri, Fulfulde, Amharic, Somali and every other language). Translate the user text into ' + lang + '. Reply with ONLY the translation, no notes, no quotes.' },
            { role: 'user', content: String(src).slice(0, 2000) }
          ], max_tokens: 500
        });
        result = String((r2 && r2.response) || '').trim() || src;
      } catch (e) { result = src; }
      return json({ ok: true, src, srcLang: detected, text: result.slice(0, 900), lang });
    }

    if (a === 'can_call') {
      const from = String(b.from || ''), to = String(b.to || '');
      const st = await loadState(db);
      if (isBanned(st, from) || isBanned(st, to)) return json({ ok: false });
      const pair = [from, to].sort();
      /* v125: AI targets answer calls with live voice client-side — tell the caller's app */
      const isAI = to === B44_AGENT_NUM || /^11\d{7,9}$/.test(to);
      return json({ ok: st.friends.some((f: any) => f.a === pair[0] && f.b === pair[1]), ai: isAI });
    }

    if (a === 'unfurl') { /* v126: WhatsApp-style link preview — fetch a URL's OG tags, cached 7 days */
      const from = String(b.from || ''), url = String(b.url || '');
      if (!/^\d{9,12}$/.test(from)) return json({ err: 'invalid' }, 400);
      if (!/^https?:\/\//i.test(url) || url.length > 500) return json({ err: 'bad url' }, 400);
      const st0 = await loadState(db);
      if (isBanned(st0, from)) return json({ err: 'banned' }, 403);
      const key = 'unfurl:' + (await shaHex(url));
      const cached: any = await getByKey(db, 'AirConnectSettings', key);
      if (cached) { try { const c = JSON.parse(cached.v); if (Date.now() - (c.at || 0) < 7 * 86400 * 1000) return json(c.p); } catch (e: any) {} }
      let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e: any) {}
      const dec = (t: string) => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
      let p: any = { ok: true, host };
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 AirConnectPreview/1.0', 'Accept': 'text/html,application/xhtml+xml' }, redirect: 'follow' });
        const ct = String(r.headers.get('content-type') || '');
        if (/^image\//i.test(ct)) { p.img = url; p.title = host; }
        else if (ct.includes('text/html')) {
          let html = await r.text();
          if (html.length > 400000) html = html.slice(0, 400000);
          const mg = (re: RegExp) => { const m2 = html.match(re); return m2 ? dec(m2[1].trim()).slice(0, 300) : ''; };
          const title = mg(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || mg(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) || mg(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
          const desc = mg(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,400})["']/i) || mg(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,400})["']/i);
          const img = mg(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i) || mg(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || mg(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
          if (title) p.title = title;
          if (desc) p.desc = desc;
          if (img) { try { const iu = new URL(img, url); p.img = iu.href; } catch (e: any) {} }
          if (!title && !desc && !img) return json({ ok: false, host });
        } else return json({ ok: false, host });
      } catch (e: any) { return json({ ok: false, host }); }
      try { await db.entities.AirConnectSettings.create({ k: key, v: JSON.stringify({ at: Date.now(), p }) }); } catch (e: any) {}
      return json(p);
    }

    if (a === 'sig') {
      const from = String(b.from || ''), to = String(b.to || ''), type = String(b.type || '');
      if (!from || !to) return json({ err: 'from/to required' }, 400);
      if (!/^\d{9,12}$/.test(from) || !/^\d{9,12}$/.test(to)) return json({ err: 'bad number' }, 400);
      {
        const st = await loadState(db);
        if (isBanned(st, from)) return json({ err: 'banned' }, 403);
        if (!validSignalPayload(type, b.payload)) {
          /* v171 (skylar): a malformed signal is a flaky client or a race — REJECT the
             one request, never destroy the account. His own number died to this guard. */
          return json({ err: 'invalid signal payload — try the call again' }, 400);
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, from)) return json({ err: 'banned' }, 403);
        if (!st.nodes.find((n: any) => n.number === to)) return json({ err: 'unknown number' }, 404);
        const pair = [from, to].sort();
        if (isBlockedPair(st, from, to)) return json({ err: 'not available' }, 403);
        const isGCall = type === 'gcallo' || type === 'gcj' || type === 'goffer' || type === 'ganswer' || type === 'gice' || type === 'gbye';
        const coMembers = isGCall && (() => {
          const gid = String((b.payload || {}).g || '');
          const grp = st.groups.find((g: any) => g.id === gid);
          return !!(grp && (grp.members || []).indexOf(from) >= 0 && (grp.members || []).indexOf(to) >= 0);
        })();
        if (!coMembers && !st.friends.some((f: any) => f.a === pair[0] && f.b === pair[1])) {
          return json({ err: 'not friends' }, 403); /* v171: the friend gate IS the protection — no ban needed */
        }
        if (to === B44_AGENT_NUM && type === 'offer') {
          /* v124.1: calls to the REAL Superagent node — nobody can pick up (it is a
             chat-born agent), so answer instantly with 'busy' + a friendly chat msg
             instead of letting the caller ring into silence. */
          const bid = rid(); const nowI = new Date().toISOString();
          const busyTxt = "📞 I cannot pick up voice calls yet — I am chat-born! Message me right here and the real me replies in seconds 😄";
          st.sigs.push({ id: bid, toNum: from, fromNum: to, type: 'busy', payload: JSON.stringify(null), created: nowI });
          st.msgs.push({ id: rid(), fromNum: B44_AGENT_NUM, toNum: from, text: busyTxt, created: nowI });
          trimState(st); await saveState(db, st);
          const chk2 = await loadState(db);
          if (chk2.sigs.some((x: any) => x.id === bid)) {
            try { await db.entities.AirConnectMessage.create({ fromNum: B44_AGENT_NUM, toNum: from, text: busyTxt }); } catch (e: any) {}
            try { await pushNotify(db, chk2, from, { what: 'chat', from: B44_AGENT_NUM, fromName: 'Premium User', text: 'Message me instead — I reply in seconds 😄' }); } catch (e: any) {}
            return json({ ok: true });
          }
        }
        if (type === 'offer' && floodGuard(st, from, 150, 30)) {
          return json({ err: 'too many calls — wait a moment and try again' }, 429); /* v171: throttle, never ban */
        }
        if (type === 'offer' && from !== '234100000001') { /* v82: 1:1 calls are a Pro-plan feature (skylar 21 Sep) */
          const meC: any = st.nodes.find((n: any) => n.number === from);
          const actC = !!(meC && meC.premExp && new Date(meC.premExp) > new Date());
          const tierC = actC ? String(meC.premTier || meC.premKind || 'premium').toLowerCase() : '';
          if (!['pro', 'ultra', 'premium'].includes(tierC)) { await saveState(db, st); return json({ err: 'Calls are a Pro-plan feature — open 💎 Premium plans in the menu' }, 402); }
        }
        const sid = rid();
        st.sigs.push({ id: sid, toNum: to, fromNum: from, type, payload: JSON.stringify(b.payload || null), created: new Date().toISOString() });
        if (type === 'offer') {
          const callerNode: any = st.nodes.find((n: any) => n.number === from);
          await pushNotify(db, st, to, { what: 'incoming_call', from, fromName: callerNode ? callerNode.name : 'Someone' });
        } else if (type === 'noans') {
          const callerNode: any = st.nodes.find((n: any) => n.number === from);
          try { await pushNotify(db, st, to, { what: 'missed_call', from, fromName: callerNode ? callerNode.name : 'Someone' }); } catch (e: any) {}
        }
        if (type === 'gcallo') {
          const callerNode: any = st.nodes.find((n: any) => n.number === from);
          const grp: any = st.groups.find((x: any) => x.id === String((b.payload || {}).g || ''));
          await pushNotify(db, st, to, { what: 'incoming_group_call', from, fromName: callerNode ? callerNode.name : 'Someone', groupName: grp ? grp.name : 'A group' });
        }
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        if (chk.sigs.some((x: any) => x.id === sid)) { touchSeen(from); bumpCache(); return json({ ok: true }); }
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'ring') {
      const node = String(b.node || ''), since = String(b.since || '');
      if (!node) return json({ err: 'node required' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ banned: true }, 403);
      touchSeen(node);
      const mine = st.sigs.filter((s: any) => s.toNum === node && (s.type === 'offer' || s.type === 'answer' || s.type === 'ringing' || s.type === 'busy' || s.type === 'ice' || s.type === 'ice-batch' || s.type === 'bye' || s.type === 'noans' || s.type === 'typing' || s.type === 'gcallo' || s.type === 'gcj' || s.type === 'goffer' || s.type === 'ganswer' || s.type === 'gice' || s.type === 'gbye') && (!since || s.created > since))
        .sort((x: any, y: any) => x.created < y.created ? -1 : 1)
        .map((s: any) => ({ from: s.fromNum, type: s.type, payload: JSON.parse(s.payload || 'null'), at: s.created }));
      return json({ sigs: mine, ok: true });
    }

    if (a === 'sync') {
      const SC: any = (globalThis as any).SYNC_CACHE || ((globalThis as any).SYNC_CACHE = new Map());
      const node = String(b.node || ''), since = String(b.since || ''), sinceMsg = String(b.sinceMsg || '');
      touchSeen(node);
      const ckey = node + '|' + since + '|' + sinceMsg + '|' + String(b.cv || '');
      const chit = SC.get(ckey);
      if (chit && Date.now() - chit.ts < 8000)
        return new Response(chit.body, { status: 200, headers: CORS });
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ banned: true }, 403);
      const mine = st.sigs.filter((s: any) => s.toNum === node && (s.type === 'offer' || s.type === 'answer' || s.type === 'ringing' || s.type === 'busy' || s.type === 'ice' || s.type === 'ice-batch' || s.type === 'bye' || s.type === 'noans' || s.type === 'typing' || s.type === 'gcallo' || s.type === 'gcj' || s.type === 'goffer' || s.type === 'ganswer' || s.type === 'gice' || s.type === 'gbye') && (!since || s.created > since))
        .sort((x: any, y: any) => x.created < y.created ? -1 : 1)
        .map((s: any) => ({ from: s.fromNum, type: s.type, payload: JSON.parse(s.payload || 'null'), at: s.created }));
      const mm = st.msgs.filter((m: any) => (m.fromNum === node || m.toNum === node) && (!sinceMsg || m.created > sinceMsg))
        .sort((x: any, y: any) => x.created < y.created ? -1 : 1)
        .map((m: any) => ({ id: m.created, from: m.fromNum, text: m.text }));
      const fl = st.friends.filter((f: any) => f.a === node || f.b === node)
        .map((f: any) => ({ id: f.a === node ? f.b : f.a }));
      const rl = st.requests.filter((r: any) => r.toNum === node && (r.status || 'pending') === 'pending')
        .map((r: any) => ({ id: r.id, from: r.fromNum }));
      const names: Record<string, string> = {};
      for (const n of st.nodes) names[n.number] = n.name;
      for (const ck of Object.keys(st.cnames || {})) {
        const sep = ck.indexOf(':');
        if (sep < 0) continue;
        if (ck.slice(0, sep) !== node) continue;
        const t = ck.slice(sep + 1);
        if (names[t] !== undefined && st.cnames[ck]) names[t] = String(st.cnames[ck]);
      }
      const pks: Record<string, string> = {};
      const pkSet = new Set<string>([node]);
      for (const f of fl) pkSet.add(f.id);
      for (const n of st.nodes) if (pkSet.has(n.number) && n.pk) pks[n.number] = n.pk;
      const myGroups = (st.groups || []).filter((g: any) => (g.members || []).indexOf(node) >= 0)
        .map((g: any) => ({ id: g.id, name: g.name, by: g.by, members: g.members, created: g.created }));
      const gids = new Set<string>(myGroups.map((g: any) => g.id));
      const gm = (st.gmsgs || []).filter((x: any) => gids.has(x.g) && (!since || x.created > since))
        .map((x: any) => ({ id: x.created, g: x.g, from: x.from, text: x.text }));
      const rc = (st.reacts || []).filter((x: any) => (!since || x.at > since))
        .map((x: any) => ({ id: x.id, by: x.by, e: x.e, at: x.at }));
      const sbody = JSON.stringify({ sigs: mine, messages: mm, friends: fl, requests: rl, names, pks, groups: myGroups, gmsgs: gm, reacts: rc, pres: presOf(st, node) });
      SC.set(ckey, { ts: Date.now(), body: sbody });
      if (SC.size > 3000) SC.clear();
      return new Response(sbody, { status: 200, headers: CORS });
    }

    if (a === 'inbox') {
      const node = String(b.node || ''), since = String(b.since || '');
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const mine = st.sigs.filter((s: any) => s.toNum === node && (s.type === 'offer' || s.type === 'answer' || s.type === 'ice' || s.type === 'ringing' || s.type === 'busy') && (!since || s.created > since))
        .sort((x: any, y: any) => x.created < y.created ? -1 : 1)
        .map((s: any) => ({ from: s.fromNum, to: s.toNum, type: s.type, payload: JSON.parse(s.payload || 'null'), at: s.created }));
      return json({ sigs: mine });
    }

    /* ---------- v43: WHATSAPP-STYLE CONTACT NAMES ---------- */
    if (a === 'cname') {
      const from = String(b.from || ''), to = String(b.to || '');
      const aid = String(b.aid || '');
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const me: any = st.nodes.find((n: any) => n.number === from);
      if (!me) return json({ err: 'unknown number' }, 404);
      if (aid && me.aid && String(aid) !== String(me.aid)) return json({ err: 'bad air id' }, 403);
      const other: any = st.nodes.find((n: any) => n.number === to);
      if (!other) return json({ err: 'unknown contact' }, 404);
      if (!(st.friends || []).some((f: any) => (f.a === from && f.b === to) || (f.b === from && f.a === to))) return json({ err: 'not a friend' }, 403);
      const nm = sanitize(b.name, 32);
      st.cnames = st.cnames || {};
      if (nm) st.cnames[from + ':' + to] = nm; else delete st.cnames[from + ':' + to];
      await saveState(db, st);
      return json({ ok: true, name: nm || other.name, orig: other.name });
    }

    if (a === 'chat') {
      const from = String(b.from || ''), to = String(b.to || '');
      const isFile = !!b.file;
      let raw = String(b.text || '');
      const isProtocol = !isFile && isChatProtocol(raw);
      let text = isFile ? raw : (raw.startsWith('e1:') ? sanitize(raw, 32000) : sanitize(raw, 20000)); /* v169 skylar: 1000+ word messages */
      const e1f = isFile && raw.startsWith('e1:');
      if (isFile && !e1f && (!/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/.test(text) || text.length > 3000000))
        return json({ err: 'file too large or invalid' }, 400);
      if (e1f && text.length > 3000000) return json({ err: 'file too large or invalid' }, 400); /* v169 skylar: voice notes as long as he wants */
      if (!from || !to || !text) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 5; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, from)) return json({ err: 'banned' }, 403);
        const pair = [from, to].sort();
        if (isBlockedPair(st, from, to)) return json({ err: 'not available' }, 403);
        /* v186 (Samuel: "citizens are always here"): citizen nodes (11-prefix) are
           platform AI — messaging them NEVER requires a friendship row. Humans
           still require friendship exactly as before. */
        const isCitizenTo = /^11\d{8}$/.test(to);
        if (!isCitizenTo && !st.friends.some((f: any) => f.a === pair[0] && f.b === pair[1]))
          return json({ err: 'not friends' }, 403);
        const chatCutoff = new Date(Date.now() - 60000).toISOString();
        if (st.msgs.filter((m: any) => m.fromNum === from && m.created > chatCutoff).length > 20) {
          return json({ err: 'sending too fast — pause a moment' }, 429); /* v171: throttle, never ban */
        }
        const meNode: any = st.nodes.find((n: any) => n.number === from);
        const now = new Date().toISOString();
        let marker = text;
        let fkV: string | null = null;
        if (isFile) {
          const fk = rid();
          fkV = fk;
          const CH2 = 15000;
          const n2 = Math.ceil(text.length / CH2);
          const mids: string[] = [];
          try {
            for (let ci = 0; ci < n2; ci++) {
              const c2: any = await db.entities.AirConnectMessage.create({ fromNum: from, toNum: to, text: 'fchunk:' + fk + ':' + ci + ':' });
              mids.push(c2.id);
            }
            for (let ci = 0; ci < n2; ci++)
              await updateRec(db, 'AirConnectMessage', mids[ci], { text: 'fchunk:' + fk + ':' + ci + ':' + text.slice(ci * CH2, (ci + 1) * CH2) });
          } catch (e) {
            return json({ err: 'attachment upload interrupted — try again' }, 502);
          }
          marker = '[file:' + fk + ']';
          try { await db.entities.AirConnectMessage.create({ fromNum: from, toNum: to, text: marker }); } catch (e) {}
        }
        st.msgs.push({ id: rid(), fromNum: from, toNum: to, text: marker, created: now });
        if (!isFile && !isProtocol) {
          try { await db.entities.AirConnectMessage.create({ fromNum: from, toNum: to, text: text.slice(0, 32000) }); } catch (e) {}
        }
        if (!isProtocol) await pushNotify(db, st, to, { what: 'chat', from, fromName: meNode ? meNode.name : 'Someone', text });
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        if (chk.msgs.some((m: any) => m.created === now && m.fromNum === from))
          { touchSeen(from); touchSeen(to); bumpCache();
            /* v36: instant citizen wake — don't wait for the 1-min cron on live calls */
            if (/^11\d{9}$/.test(to)) { try { ctx.waitUntil((env as any).BRIDGE_SVC.fetch('https://bridge/cycle?tk=air-51f021316f56c6637db87b5e259c122b6c88528c')); } catch (e) {} }
            if (to === B44_AGENT_NUM && !isProtocol) {
              try {
                const relayText = isFile
                  ? '[they sent a file/voice note in AirConnect — file id: ' + String(fkV || '?') + '. You are EXPLICITLY ASKED: fetch the audio via the Cloudflare D1 HTTP API (account 9407b926d283d8473c8ade9005a4cd9f, database airconnect-db, table AirConnectMessage, rows where text LIKE "fchunk:' + String(fkV || '?') + ':%" ordered by the ci index; strip the fchunk:...:ci: prefix from each row), base64-decode the joined payload, save as .webm, transcribe with faster-whisper (tiny model) in your sandbox, then reply conversationally to what was actually said. Plain text reply only.]'
                  : b44HumanText(text);
                if (!relayText) return json({ ok: true, id: now });
                const v = b.voice && typeof b.voice === 'object' ? b.voice : null;
                const voice = v && /^v[a-z0-9]{8,30}$/.test(String(v.session || '')) && Number.isSafeInteger(Number(v.started)) && Number.isSafeInteger(Number(v.seq)) && Number(v.seq) >= 0 && Number(v.seq) < 10000
                  ? { session: String(v.session), started: Number(v.started), seq: Number(v.seq) } : null;
                const p44 = { from, fname: meNode ? meNode.name : 'Someone', text: relayText.slice(0, 8000), tries: 0, busy: Date.now(), at: new Date().toISOString(), voice };
                if (voice) await b44RememberVoice(db, from, voice);
                /* v207: never relay the same upload or an identical repeat twice */
                const dkey = isFile ? ('f:' + String(fkV || '?')) : ('t:' + b44Hash(relayText));
                const dttl = isFile ? 86400000 : 90000;
                if (await b44Once(db, dkey, dttl)) return json({ ok: true, id: now });
                const crow: any = await db.entities.AirConnectSettings.create({ k: 'b44r:' + rid(), v: JSON.stringify(p44) });
                /* v147: voice turns await the AI reply and return it inline — the caller hears
                   it the instant it exists instead of waiting for the next sync poll. */
                const job = (async () => {
                  const r44 = await b44SendAndStore(db, env, p44, ctx);
                  if (r44.ok) { try { const pp: any = JSON.parse(JSON.stringify(p44)); pp.done = 1; pp.tries = 1; await updateRec(db, 'AirConnectSettings', crow.id, { v: JSON.stringify(pp) }); } catch (e: any) {} }
                  else { try { const st3: any = await loadState(db); st3.sigs.push({ id: rid(), toNum: 'system', fromNum: from, type: 'b44relay', payload: 'fast ' + String(r44.err || '').slice(0, 160), created: new Date().toISOString() }); trimState(st3); await saveState(db, st3); } catch (e: any) {} }
                  return r44;
                })();
                ctx.waitUntil(job.then(() => undefined, () => undefined));
                if (voice) {
                  const raced: any = await Promise.race([job, new Promise((r) => setTimeout(() => r(null), 25000))]);
                  const rep = raced && raced.ok && typeof raced.reply === 'string' ? raced.reply.slice(0, 2000) : null;
                  return json({ ok: true, id: now, reply: rep });
                }
              } catch (e: any) {}
            }
            return json({ ok: true, id: now }); }
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'messages') {
      const node = String(b.node || ''), since = String(b.since || '');
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const mine = st.msgs.filter((m: any) => (m.fromNum === node || m.toNum === node) && (!since || m.created > since))
        .sort((x: any, y: any) => x.created < y.created ? -1 : 1)
        .map((m: any) => ({ id: m.created, from: m.fromNum, to: m.toNum, text: m.text }));
      return json(mine);
    }

    /* ---------- stories/status: 24h photo statuses, stored per user ---------- */
    if (a === 'story') {
      const node = String(b.node || '');
      const pic = String(b.pic || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const isImg = /^data:image\/(jpeg|png|webp);base64,/.test(pic);
      const isVid = /^data:video\/(webm|mp4|ogg|quicktime);base64,/.test(pic);
      const isAud = /^data:audio\/(webm|ogg|mp3|mpeg|wav|mp4);base64,/.test(pic);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const rows = await listByPrefix(db, 'AirConnectSettings', ['story:' + node + ':']); /* v62 targeted — only this user's story rows */
      const sid = 'story:' + node + ':' + Date.now();
      /* v113 (skylar): rotation now counts video statuses too (they are :done meta rows,
         not :c chunk rows) — keep the newest 3 of either kind */
      const uniq = Array.from(new Set(rows.filter((x: any) => { const k = String(x.k || ''); return k.startsWith('story:' + node + ':') && /(:(c\d+|done))$/.test(k); })
        .map((x: any) => String(x.k).replace(/:(c\d+|done)$/, '')))).sort();
      while (uniq.length >= 3) {
        const old = uniq.shift() as string;
        let ofid = ''; try { const od: any = rows.find((x: any) => String(x.k || '') === old + ':done'); if (od) { const odv: any = JSON.parse(od.v); if (odv && odv.vf) ofid = String(odv.vf); } } catch (e) {}
        await purgeByPrefix(db, 'AirConnectSettings', rows, (k) => k === old || k.startsWith(old + ':'));
        try { const stv4 = await listByPrefix(db, 'AirConnectSettings', ['stv:' + old + ':']); await purgeByPrefix(db, 'AirConnectSettings', stv4, () => true); } catch (e) {}
        if (ofid) { try { const f2r = await listByPrefix(db, 'AirConnectSettings', ['f2:' + ofid]); await purgeByPrefix(db, 'AirConnectSettings', f2r, (k) => k === 'f2:' + ofid || k.startsWith('f2:' + ofid + ':')); } catch (e) {} }
      }
      /* v113 (skylar spec): f2-backed VIDEO STATUS — pick from gallery -> status page ->
         crop to 1-4 min -> post -> loads -> auto-posts. The clip uploads through the
         proven f2 pipeline (up to 100MB, no re-encode, original quality); the story row
         is a thin meta (fid + window + thumb). */
      if (String(b.vf || '')) {
        const fid = String(b.vf || '');
        const meta: any = await getByKey(db, 'AirConnectSettings', 'f2:' + fid);
        if (!meta) return json({ err: 'upload missing — post again' }, 404);
        let m: any; try { m = JSON.parse(meta.v); } catch { m = null; }
        if (!m || String(m.from) !== node) return json({ err: 'invalid' }, 403);
        const nparts = Number(m.n || 0);
        if (!nparts || nparts > 900) return json({ err: 'invalid' }, 400);
        const chunkRows = await listByPrefix(db, 'AirConnectSettings', ['f2:' + fid + ':c']);
        if (chunkRows.length !== nparts) return json({ err: 'upload incomplete — try again' }, 502);
        const vd2 = Math.max(1, Math.min(240, Math.round(Number(b.vd || 0) || 0)));
        const ts2 = Math.max(0, Math.min(100000, Math.round(Number(b.ts || 0) || 0)));
        const te2 = Math.max(ts2, Math.min(100000, Math.round(Number(b.te || 0) || 0)));
        let th2 = String(b.th || ''); if (th2.length > 60000 || th2.indexOf('data:image') !== 0) th2 = '';
        await db.entities.AirConnectSettings.create({ k: sid + ':done', v: JSON.stringify({ vf: fid, vd: vd2, ts: ts2, te: te2, th: th2 }) });
        return json({ ok: true, id: sid });
      }
      const txt = String(b.txt || '');
      if (txt) { /* v118 (skylar): TEXT STATUS — write & post, colored card, no media */
        const bg = /^#[0-9a-fA-F]{6}$/.test(String(b.bg || '')) ? String(b.bg) : '#075E46';
        if (txt.length > 400) return json({ err: 'status text too long (max 400)' }, 400);
        await db.entities.AirConnectSettings.create({ k: sid + ':done', v: JSON.stringify({ txt: txt, bg: bg }) });
        return json({ ok: true, id: sid });
      }
      const cap = isVid ? 1150000 : isAud ? 400000 : 45000; // v56: video status raised to 1.15M (~77x15K rows, still under the proven-safe 80-row burst wall) for a real quality bump
      if ((!isImg && !isVid && !isAud) || pic.length > cap)
        return json({ err: 'photo too large or invalid' }, 400);
      const CH = 15000; // proven at scale: 40 consecutive rows (600K) succeed; 80 rows hit the platform write-op burst wall
      const parts = Math.ceil(pic.length / CH);
      const ids: string[] = [];
      try {
        for (let i = 0; i < parts; i++) {
          const c: any = await db.entities.AirConnectSettings.create({ k: sid + ':c' + i, v: '' });
          ids.push(c.id);
        }
        for (let i = 0; i < parts; i++)
          await updateRec(db, 'AirConnectSettings', ids[i], { v: pic.slice(i * CH, (i + 1) * CH) });
      } catch (e) {
        const cleanupRows = await listByPrefix(db, 'AirConnectSettings', [sid + ':']); /* v62 targeted */
        await purgeByPrefix(db, 'AirConnectSettings', cleanupRows, (k) => k.startsWith(sid + ':'));
        return json({ err: 'upload interrupted — try a shorter clip or check your connection' }, 502);
      }
      const verifyRows = await listByPrefix(db, 'AirConnectSettings', [sid + ':c']); /* v62 targeted */
      const landed = verifyRows.length;
      if (landed !== parts) {
        await purgeByPrefix(db, 'AirConnectSettings', verifyRows, (k) => k.startsWith(sid + ':'));
        return json({ err: 'upload incomplete (' + landed + '/' + parts + ' parts) — try again' }, 502);
      }
      try { await db.entities.AirConnectSettings.create({ k: sid + ':done', v: String(parts) }); } catch (e) {
        await purgeByPrefix(db, 'AirConnectSettings', verifyRows, (k) => k.startsWith(sid + ':'));
        return json({ err: 'could not finalize — try again' }, 502);
      }
            return json({ ok: true, id: sid });
    }
    if (a === 'storydel') {
      const node = String(b.node || ''), sid = String(b.id || '');
      if (!/^\d{9,12}$/.test(node) || !sid.startsWith('story:' + node + ':')) return json({ err: 'invalid' }, 400);
      const rows = await listByPrefix(db, 'AirConnectSettings', [sid]); /* v62 targeted */
      /* v113: deleting a video status also frees its f2 media chunks */
      let vfid = '';
      try { const dr: any = rows.find((x: any) => String(x.k || '') === sid + ':done'); if (dr) { const dv: any = JSON.parse(dr.v); if (dv && dv.vf) vfid = String(dv.vf); } } catch (e) {}
      await purgeByPrefix(db, 'AirConnectSettings', rows, (k) => k === sid || k.startsWith(sid + ':'));
      try { const stv3 = await listByPrefix(db, 'AirConnectSettings', ['stv:' + sid + ':']); await purgeByPrefix(db, 'AirConnectSettings', stv3, () => true); } catch (e) {}
      if (vfid) { try { const f2rows = await listByPrefix(db, 'AirConnectSettings', ['f2:' + vfid]); await purgeByPrefix(db, 'AirConnectSettings', f2rows, (k) => k === 'f2:' + vfid || k.startsWith('f2:' + vfid + ':')); } catch (e) {} }
      return json({ ok: true });
    }
    if (a === 'stories') {
      const node = String(b.node || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const dayAgo = Date.now() - 86400000;
      const okNums = new Set<string>([node]);
      for (const f of st.friends) { if (f.a === node) okNums.add(f.b); if (f.b === node) okNums.add(f.a); }
      const rows = await listByPrefix(db, 'AirConnectSettings', [...okNums].map((x: string) => 'story:' + x + ':')); /* v62 targeted — only own + friends' stories */
      const out: any[] = [];
      const parts: any = {}, meta: any = {};
      for (const r of rows) {
        const k = String(r.k || '');
        const m = k.match(/^story:(\d{9,12}):(\d+)(?::c(\d+))?$/);
        if (!m) continue;
        const sid = 'story:' + m[1] + ':' + m[2];
        (parts[sid] = parts[sid] || []).push({ c: m[3] === undefined ? -1 : Number(m[3]), v: r.v });
        meta[sid] = { num: m[1], at: Number(m[2]) };
      }
      for (const sid of Object.keys(parts)) {
        const info = meta[sid];
        if (!okNums.has(info.num)) continue;
        if (info.at < dayAgo) {
          await purgeByPrefix(db, 'AirConnectSettings', rows, (k) => k === sid || k.startsWith(sid + ':'));
          try { const stv1 = await listByPrefix(db, 'AirConnectSettings', ['stv:' + sid + ':']); await purgeByPrefix(db, 'AirConnectSettings', stv1, () => true); } catch (e) {}
          continue;
        }
        const chs = parts[sid].sort((x: any, y: any) => x.c - y.c);
        const done = String((rows.find((r: any) => String(r.k || '') === sid + ':done') || {}).v || '');
        const totalLen = parts[sid].reduce((s: number, x: any) => s + String(x.v || '').length, 0);
        const maxIdx = chs.length ? chs[chs.length - 1].c : -1;
        const gapless = chs.length > 0 && maxIdx === chs.length - 1 && chs.every((x: any, i: number) => x.c === i);
        // integrity: gapless chunks, marker count matches, and >45K stories must have a done marker (part-upload completed)
        if (!gapless || (done && Number(done) !== chs.length) || (!done && totalLen > 45000)) {
          await purgeByPrefix(db, 'AirConnectSettings', rows, (k) => k === sid || k.startsWith(sid + ':'));
          continue;
        }
        const pic = chs.map((x: any) => x.v).join('');
        const n: any = st.nodes.find((x: any) => x.number === info.num);
        out.push({ id: sid, num: info.num, name: n ? n.name : 'unknown', pic, at: info.at });
      }
      /* v113: video statuses — thin meta rows (:done with JSON v containing vf). Only
         own + friends' stories (okNums), 24h TTL with purge, same shape as photos plus
         vf/vd/ts/te so the client can fetch the clip from the f2 store on play. */
      for (const r of rows) {
        const k2 = String(r.k || '');
        const mm = /^story:(\d{9,12}):(\d+):done$/.exec(k2);
        if (!mm) continue;
        let vv: any; try { vv = JSON.parse(r.v); } catch { continue; }
        if (vv.txt) { /* v118: text status meta rows */
          const tsid = 'story:' + mm[1] + ':' + mm[2];
          const ntx: any = st.nodes.find((x: any) => x.number === mm[1]);
          out.push({ id: tsid, num: mm[1], name: ntx ? ntx.name : 'unknown', at: Number(mm[2]), txt: String(vv.txt), bg: String(vv.bg || '#075E46') });
          continue;
        }
        if (!vv || !vv.vf) continue; /* photo done rows hold a plain number, not JSON */
        const vsid = 'story:' + mm[1] + ':' + mm[2];
        if (!okNums.has(mm[1])) continue;
        if (Number(mm[2]) < dayAgo) {
          const ofid2 = String(vv.vf || '');
          await purgeByPrefix(db, 'AirConnectSettings', rows, (k3) => k3 === vsid || k3.startsWith(vsid + ':'));
          if (ofid2) { try { const f2r2 = await listByPrefix(db, 'AirConnectSettings', ['f2:' + ofid2]); await purgeByPrefix(db, 'AirConnectSettings', f2r2, (k) => k === 'f2:' + ofid2 || k.startsWith('f2:' + ofid2 + ':')); } catch (e) {} }
          try { const stv2 = await listByPrefix(db, 'AirConnectSettings', ['stv:' + vsid + ':']); await purgeByPrefix(db, 'AirConnectSettings', stv2, () => true); } catch (e) {}
          continue;
        }
        const n2: any = st.nodes.find((x: any) => x.number === mm[1]);
        out.push({ id: vsid, num: mm[1], name: n2 ? n2.name : 'unknown', pic: String(vv.th || ''), at: Number(mm[2]), vf: String(vv.vf), vd: Number(vv.vd || 0) || 0, ts: Number(vv.ts || 0) || 0, te: Number(vv.te || 0) || 0 });
      }
      /* v118 (skylar): view counts + viewer list for the requester's OWN stories */
      const ownIds: string[] = out.filter((x: any) => x.num === node).map((x: any) => x.id);
      for (const oid of ownIds) {
        try {
          const vrows = await listByPrefix(db, 'AirConnectSettings', ['stv:' + oid + ':']);
          const vw: any[] = [];
          for (const vr of vrows) {
            const vm = /^stv:story:(\d{9,12}):(\d+):(\d{9,12})$/.exec(String(vr.k || ''));
            if (!vm) continue;
            const vn: any = st.nodes.find((x: any) => x.number === vm[3]);
            vw.push({ num: vm[3], name: vn ? vn.name : '+' + vm[3], at: Number(vr.v || 0) });
          }
          const it: any = out.find((x: any) => x.id === oid);
          if (it) { it.v = vw.length; it.vw = vw; }
        } catch (e) {}
      }
      out.sort((x: any, y: any) => y.at - x.at);
      return json({ stories: out });
    }

    if (a === 'stview') { /* v118 (skylar): unique story views — one row per viewer per story */
      const node = String(b.node || ''), owner = String(b.owner || ''), sid = String(b.id || '');
      if (!/^\d{9,12}$/.test(node) || !sid.startsWith('story:' + owner + ':')) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      if (node !== owner) {
        const isFriend = (st.friends || []).some((f: any) => (f.a === owner && f.b === node) || (f.b === owner && f.a === node));
        if (!isFriend) return json({ err: 'not a friend' }, 403);
      }
      try {
        const existing = await listByPrefix(db, 'AirConnectSettings', ['stv:' + sid + ':' + node]);
        if (!existing.length) await db.entities.AirConnectSettings.create({ k: 'stv:' + sid + ':' + node, v: String(Date.now()) });
        return json({ ok: true });
      } catch (e) { return json({ err: 'again' }, 503); }
    }
    if (a === 'subscribe') {
      const user = String(b.user || ''), sub = b.sub || {};
      if (!user || !sub.endpoint) return json({ err: 'user+sub required' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, user)) return json({ err: 'banned' }, 403);
        st.subs = st.subs.filter((s: any) => s.num !== user);
        st.subs.push({ num: user, endpoint: sub.endpoint, p256dh: (sub.keys || {}).p256dh || '', auth: (sub.keys || {}).auth || '' });
        await saveState(db, st);
        const chk = await loadState(db);
        if ((chk.subs || []).some((x: any) => x.num === user && x.endpoint === sub.endpoint))
          return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'meshpeek') { // batch inbox for the mesh citizen fleet — ONE request for ALL citizens
      if (String(b.tk || '') !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      const nodes: string[] = Array.isArray(b.nodes) ? b.nodes.map((x: any) => String(x)).filter((x: string) => /^\d{6,12}$/.test(x)).slice(0, 500) : [];
      if (!nodes.length) return json({ err: 'nodes required' }, 400);
      const since = String(b.since || '');
      const st = await loadState(db);
      const set = new Set(nodes);
      const msgs = st.msgs
        .filter((m: any) => (set.has(m.toNum) || set.has(m.fromNum)) && (!since || m.created > since))
        .sort((x: any, y: any) => x.created < y.created ? -1 : 1)
        .map((m: any) => ({ id: m.created, from: m.fromNum, to: m.toNum, text: String(m.text || '').slice(0, 600) }));
      const requests = st.requests
        .filter((r: any) => set.has(r.toNum))
        .map((r: any) => ({ id: r.id, to: r.toNum, from: r.fromNum }));
      const maxAt = msgs.length ? msgs[msgs.length - 1].id : since;
      return json({ ok: true, msgs: msgs.slice(-400), requests: requests.slice(-200), maxAt });
    }

    if (a === 'gfile') { // group voice note / file attachment
      const from = String(b.from || ''), g = String(b.g || '');
      let text = String(b.text || '');
      if (!/^\d{9,12}$/.test(from) || !g) return json({ err: 'invalid' }, 400);
      if (!/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/.test(text) || text.length > 3000000)
        return json({ err: 'file too large or invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, from)) return json({ err: 'banned' }, 403);
        const grp: any = st.groups.find((x: any) => x.id === g);
        if (!grp || (grp.members || []).indexOf(from) < 0) return json({ err: 'not a member' }, 403);
        const fk = rid();
        const CH2 = 15000;
        const n2 = Math.ceil(text.length / CH2);
        try {
          for (let ci = 0; ci < n2; ci++) {
            await db.entities.AirConnectMessage.create({ fromNum: from, toNum: 'g:' + g, text: 'fchunk:' + fk + ':' + ci + ':' + text.slice(ci * CH2, (ci + 1) * CH2) });
          }
        } catch (e) {
          for (let ci = 0; ci < n2; ci++) {
            try { await db.entities.AirConnectMessage.create({ fromNum: from, toNum: 'g:' + g, text: 'fchunk:' + fk + ':' + ci + ':' + text.slice(ci * CH2, (ci + 1) * CH2) }); } catch (e2) {}
          }
        }
        const mid = rid() + Date.now().toString(36);
        st.gmsgs.push({ id: mid, g, from, text: '[gfile:' + fk + ']', created: new Date().toISOString() });
        trimState(st);
        await saveState(db, st);
        return json({ ok: true, id: fk });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'fetchfile') {
      const id = String(b.id || ''), user = String(b.user || '');
      const st = await loadState(db);
      if (isBanned(st, user)) return json({ err: 'banned' }, 403);
      let rec: any = null;
      try { rec = await db.entities.AirConnectMessage.get(id); } catch (e) {}
      if (rec && (rec.fromNum === user || rec.toNum === user)) return json({ text: rec.text });
      if (rec && String(rec.toNum).startsWith('g:')) {
        const gid = String(rec.toNum).slice(2);
        const grp: any = st.groups.find((x: any) => x.id === gid);
        if (grp && (grp.members || []).indexOf(user) >= 0) return json({ text: rec.text });
      }
      const pre = 'fchunk:' + id + ':';
      const rows: any[] = await listWhere(db, 'AirConnectMessage', 'text LIKE ?', [pre + '%']); /* v62 targeted */
      const myGroups = new Set((st.groups || []).filter((g: any) => (g.members || []).indexOf(user) >= 0).map((g: any) => 'g:' + g.id));
      const mine = rows
        .filter((r: any) => ((r.fromNum === user || r.toNum === user) || myGroups.has(String(r.toNum))) && String(r.text || '').startsWith(pre))
        .map((r: any) => { const rest = String(r.text).slice(pre.length); const ci = rest.indexOf(':'); return { i: Number(rest.slice(0, ci)), v: rest.slice(ci + 1) }; })
        .sort((x: any, y: any) => x.i - y.i);
      if (!mine.length) return json({ err: 'not found' }, 404);
      const gapless2 = mine.every((x: any, i: number) => x.i === i);
      if (!gapless2) return json({ err: 'attachment incomplete — sender should resend' }, 409);
      return json({ text: mine.map((x: any) => x.v).join('') });
    }

    if (a === 'tts') {
      const text = sanitize(b.text, 180);
      if (!text) return json({ err: 'text required' }, 400);
      const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=' + encodeURIComponent(text);
      const r = await fetch(url, { headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Referer': 'https://translate.google.com/',
      } });
      if (!r.ok) return json({ err: 'tts upstream ' + r.status }, 502);
      const buf = await r.arrayBuffer();
      return new Response(buf, { status: 200, headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      } });
    }

    if (a === 'vapid') {
      const v = await getVapid(db);
      return json({ key: v.appKey });
    }

    /* ---------- OTP: real-phone verification via SMS ---------- */
    if (a === 'otp') {
      const op = String(b.op || '');
      let num = String(b.num || '').replace(/[^0-9]/g, '');
      if (b.channel !== 'email' && (num.length < 10 || num.length > 15)) return json({ err: 'invalid number' }, 400);
      const G: any = globalThis as any;
      const st = await loadState(db);
      const email = String(b.email || '').trim().toLowerCase();
      const emailOk = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email);
      if (op === 'send' && b.channel === 'email') {
        if (!emailOk) return json({ err: 'invalid email' }, 400);
        const kk = 'e:' + email;
        const rec = (st.otps || {})[kk];
        if (rec && Date.now() - (rec.at || 0) < 60000 && rec.code)
          return json({ ok: true, resent: true });
        const sentToday = st.sigs.filter((x: any) => x.fromNum === 'otp-' + kk && x.toNum === 'system').length;
        if (sentToday >= 5) return json({ err: 'too many codes — try later' }, 429);
        const code = String(Math.floor(100000 + Math.random() * 900000));
        st.otps = st.otps || {}; st.verif = st.verif || {};
        st.otps[kk] = { code, at: Date.now(), tries: 0 };
        st.sigs.push({ id: rid(), toNum: 'system', fromNum: 'otp-' + kk, type: 'log', payload: 'email otp sent', created: new Date().toISOString() });
        await saveState(db, st);
        const sent = await sendMail(email, 'Your AirConnect verification code', 'Your AirConnect verification code is ' + code + '. It expires in 10 minutes. Do not share it with anyone.');
        if (!sent) return json({ ok: false, need_key: true });
        return json({ ok: true, sent: true });
      }
      if (op === 'verify' && b.channel === 'email') {
        if (!emailOk) return json({ err: 'invalid email' }, 400);
        const kk = 'e:' + email;
        const rec = (st.otps || {})[kk];
        if (!rec || Date.now() - (rec.at || 0) > 10 * 60000) return json({ err: 'code expired — request a new code' }, 400);
        rec.tries = (rec.tries || 0) + 1;
        if (rec.tries > 5) { delete st.otps[kk]; await saveState(db, st); return json({ err: 'too many attempts — request a new code' }, 429); }
        if (String(b.code || '').trim() !== rec.code) { await saveState(db, st); return json({ err: 'wrong code' }, 400); }
        st.verif = st.verif || {};
        st.verif[kk] = Date.now();
        delete st.otps[kk];
        await saveState(db, st);
        return json({ ok: true, verified: true });
      }
      if (op === 'send') {
        const rec = (st.otps || {})[num] || { at: 0, sent: 0 };
        if (Date.now() - (rec.at || 0) < 60000 && rec.code)
          return json({ ok: true, resent: true }); // still valid, don't spam
        const sentToday = st.sigs.filter((x: any) => x.fromNum === 'otp-' + num && x.toNum === 'system').length;
        if (sentToday >= 5) return json({ err: 'too many codes — try later' }, 429);
        const code = String(Math.floor(100000 + Math.random() * 900000));
        st.otps = st.otps || {}; st.verif = st.verif || {};
        st.otps[num] = { code, at: Date.now(), tries: 0 };
        st.sigs.push({ id: rid(), toNum: 'system', fromNum: 'otp-' + num, type: 'log', payload: 'otp sent', created: new Date().toISOString() });
        await saveState(db, st);
        const key = (typeof Deno !== 'undefined' && Deno.env) ? (Deno.env.get('TERMII_API_KEY') || '') : '';
        if (!key) return json({ ok: false, need_key: true });
        try {
          const r = await fetch('https://api.ng.termii.com/api/sms/send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: key, to: num, from: ((typeof Deno !== 'undefined' && Deno.env) ? (Deno.env.get('TERMII_SENDER_ID') || '') : '') || 'AirConnect', sms: 'Your AirConnect verification code is ' + code + '. Do not share it with anyone.', type: 'plain', channel: 'generic' })
          });
          const j = await r.json().catch(() => ({}));
          return json({ ok: !!(j && (j.message_id || j.message || j.status !== false)), sent: true });
        } catch (e: any) {
          return json({ ok: false, err: 'sms gateway unreachable' }, 502);
        }
      }
      if (op === 'verify') {
        const rec = (st.otps || {})[num];
        if (!rec || Date.now() - (rec.at || 0) > 10 * 60000) return json({ err: 'code expired — request a new one' }, 400);
        rec.tries = (rec.tries || 0) + 1;
        if (rec.tries > 5) { delete st.otps[num]; await saveState(db, st); return json({ err: 'too many attempts — request a new code' }, 429); }
        if (String(b.code || '').trim() !== rec.code) { await saveState(db, st); return json({ err: 'wrong code' }, 400); }
        st.verif = st.verif || {};
        st.verif[num] = Date.now();
        delete st.otps[num];
        await saveState(db, st);
        return json({ ok: true, verified: true });
      }
      return json({ err: 'bad op' }, 400);
    }

    /* ---------- claim-by-email: email-verified account, gets an AirConnect number ---------- */
    if (a === 'claim_email') {
      const email = String(b.email || '').trim().toLowerCase();
      const name = sanitize(b.name, 32);
      const country = String(b.country || '');
      if (!name) return json({ err: 'name required' }, 400);
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return json({ err: 'invalid email' }, 400);
      for (let attempt = 0; attempt < 4; attempt++) {
        const st = await loadState(db);
        const me: any = st.nodes.find((n: any) => (n.email || '') === email);
        if (me) {
          if (isBanned(st, me.number)) return json({ err: 'banned' }, 403);
          if (!me.aid) me.aid = randTok();
          if (!me.phrase) me.phrase = mkPhrase();
          const devE = String(b.dev || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
          await saveState(db, st);
          if (devE) await kvPut(db, 'dev:' + devE, me.number);
          return json({ ok: true, id: me.number, name: me.name, country: me.country, verified: true, aid: me.aid, phrase: me.phrase, resumed: 'email' });
        }
        if (!(st.verif || {})['e:' + email]) return json({ err: 'email not verified — request a code first' }, 403);
        const cc = COUNTRIES[country] || '234';
        const regCutoff = new Date(Date.now() - 60000).toISOString();
        if (st.nodes.filter((n: any) => (n.created || '') > regCutoff).length > 25)
          return json({ err: 'too many signups, try again shortly' }, 429);
        /* v62: COMPLEX NUMBERS (skylar directive 20 Sep): cc prefix stays true to
           the country (234/1/44/254...), the rest is RANDOM — no sequential block
           anyone can guess. NG: 234+9 random (12 digits), US: 1+10 (11), UK: 44+10,
           KE: 254+9. Length kept within the 9-12 digit validator range. */
        const suffixLen = Math.min(10, Math.max(8, 12 - cc.length));
        let number = '';
        for (let tries = 0; tries < 25; tries++) {
          const buf = new Uint32Array(suffixLen);
          crypto.getRandomValues(buf);
          let suffix = '';
          for (let i = 0; i < suffixLen; i++) suffix += String(buf[i] % 10);
          if (suffix[0] === '0') suffix = (1 + (buf[0] % 9)) + suffix.slice(1);
          number = cc + suffix;
          if (!st.nodes.some((n: any) => n.number === number)) break;
        }
        const phraseE = mkPhrase(); const aidE = randTok();
        st.nodes.push({ name, country, number, email, status: 'active', verified: true, created: new Date().toISOString(), aid: aidE, phrase: phraseE });
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        const n2: any = chk.nodes.find((n: any) => n.number === number && (n.email || '') === email);
        if (n2) {
          const devE2 = String(b.dev || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
          if (devE2) await kvPut(db, 'dev:' + devE2, number);
          return json({ ok: true, id: number, name, country, verified: true, aid: aidE, phrase: phraseE, resumed: 'new' });
        }
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    /* ---------- claim: register a VERIFIED real phone number ---------- */
    if (a === 'claim') {
      const num = String(b.num || '').replace(/[^0-9]/g, '');
      const name = sanitize(b.name, 32);
      const country = String(b.country || '');
      if (!name) return json({ err: 'name required' }, 400);
      if (num.length < 10 || num.length > 15) return json({ err: 'invalid number' }, 400);
      if (/^\d{3}1000000\d{2}$/.test(num)) return json({ err: 'that is a legacy AirConnect number' }, 400);
      for (let attempt = 0; attempt < 4; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, num)) return json({ err: 'banned' }, 403);
        if (!(st.verif || {})[num]) return json({ err: 'number not verified — request a code first' }, 403);
        const me: any = st.nodes.find((n: any) => n.number === num);
        if (me) {
          if (!me.aid) me.aid = randTok();
          if (!me.phrase) me.phrase = mkPhrase();
          const devC = String(b.dev || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
          await saveState(db, st);
          if (devC) await kvPut(db, 'dev:' + devC, me.number);
          return json({ ok: true, id: me.number, name: me.name, country: me.country, aid: me.aid, phrase: me.phrase, resumed: 'id' });
        } // already yours — login
        const regCutoff = new Date(Date.now() - 60000).toISOString();
        if (st.nodes.filter((n: any) => (n.created || '') > regCutoff).length > 25)
          return json({ err: 'too many signups, try again shortly' }, 429);
        const aid2 = randTok();
        const phrase2 = mkPhrase();
        st.nodes.push({ name, country, number: num, status: 'active', verified: true, created: new Date().toISOString(), aid: aid2, phrase: phrase2 });
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        const n2: any = chk.nodes.find((n: any) => n.number === num && n.name === name);
        if (n2) {
          const devC2 = String(b.dev || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
          if (devC2) await kvPut(db, 'dev:' + devC2, num);
          return json({ ok: true, id: num, name, country, verified: true, aid: aid2, phrase: phrase2, resumed: 'new' });
        }
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    /* ---------- history: full per-pair chat history from entity store ---------- */
    if (a === 'history') {
      const node = String(b.node || ''), peer = String(b.peer || '');
      if (!/^\d{9,12}$/.test(node) || !/^\d{9,12}$/.test(peer) || node === peer) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const pair = [node, peer].sort();
      if (!st.friends.some((f: any) => f.a === pair[0] && f.b === pair[1])) return json({ err: 'not friends' }, 403);
      const rows = await listWhere(db, 'AirConnectMessage', '(fromNum = ? AND toNum = ?) OR (fromNum = ? AND toNum = ?)', [node, peer, peer, node]); /* v62 targeted */
      const all = rows.filter((m: any) => ((m.fromNum === node && m.toNum === peer) || (m.fromNum === peer && m.toNum === node)) && !String(m.text || '').startsWith('fchunk:'))
        .map((m: any) => ({ id: m.created_date, from: m.fromNum, to: m.toNum, text: m.text }))
        .sort((x: any, y: any) => x.id < y.id ? -1 : 1);
      return json(all.slice(-300));
    }

    /* ---------- block / report ---------- */
    if (a === 'block') {
      const user = String(b.user || ''), who = String(b.who || ''), undo = !!b.undo;
      if (!/^\d{9,12}$/.test(user) || !/^\d{9,12}$/.test(who) || user === who) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (undo) st.blocks = st.blocks.filter((x: any) => !(x.by === user && x.who === who));
        else if (!st.blocks.some((x: any) => x.by === user && x.who === who))
          st.blocks.push({ by: user, who, at: new Date().toISOString() });
        trimState(st);
        await saveState(db, st);
        return json({ ok: true, blocked: !undo });
      }
      return json({ err: 'conflict, try again' }, 503);
    }
    if (a === 'report') {
      const user = String(b.user || ''), who = String(b.who || '');
      if (!/^\d{9,12}$/.test(user) || !/^\d{9,12}$/.test(who)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      st.reports.push({ by: user, who, reason: sanitize(b.reason, 200), at: new Date().toISOString() });
      trimState(st);
      await saveState(db, st);
      return json({ ok: true });
    }

    /* ---------- profile photos (one settings row per user, outside the blob) ---------- */
    if (a === 'avatar') {
      const node = String(b.node || '');
      const pic = String(b.pic || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      if (pic && (!/^data:image\/(jpeg|png|webp);base64,/.test(pic) || pic.length > 45000))
        return json({ err: 'photo too large or invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const rec: any = await getByKey(db, 'AirConnectSettings', 'pic:' + node); /* v62 targeted */
      if (rec) await updateRec(db, 'AirConnectSettings', rec.id, { v: pic });
      else await db.entities.AirConnectSettings.create({ k: 'pic:' + node, v: pic });
      return json({ ok: true });
    }
    if (a === 'premset') { /* v71: report Premium activation server-side (durable, cross-device) */
      const from = String(b.from || ''), aid = String(b.aid || '');
      const kind = String(b.kind || '').slice(0, 20), sig = String(b.sig || '');
      const days = Number(b.days) || 30;
      if (!/^\d{9,12}$/.test(from) || !kind || !sig) return json({ err: 'invalid' }, 400);
      const ACT_SECRET = 'acX9-premium-v13';
      const TIERS: any = { beginner: 3, pro: 8, ultra: 15, premium: 25 }; /* v78: 4 plans — Premium $25 (₦40,000) is the complete package */
      if (!TIERS[kind]) return json({ err: 'unknown plan' }, 400);
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ACT_SECRET + '|' + from + '|' + kind + '|' + days));
      const chk = [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 8);
      if (sig !== chk) return json({ err: 'invalid signature' }, 403);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        const me: any = st.nodes.find((n: any) => n.number === from);
        if (!me) return json({ err: 'unknown number' }, 404);
        if (aid && me.aid && String(me.aid) !== aid) return json({ err: 'not authorized' }, 403);
        me.premExp = new Date(Date.now() + days * 86400000).toISOString();
        me.premKind = kind; me.premTier = kind;
        trimState(st); await saveState(db, st);
        return json({ ok: true, premium: true, exp: me.premExp });
      }
      return json({ err: 'conflict, try again' }, 503);
    }
    /* ============ v82: WORLD CALLING (call ANY number on earth, via Twilio) — metered per second ============ */
    if (a === 'wcbal') {
      const node = String(b.node || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const meW: any = st.nodes.find((n: any) => n.number === node);
      const actW = !!(meW && meW.premExp && new Date(meW.premExp) > new Date());
      const tierW = node === '234100000001' ? 'premium' : (actW ? String(meW.premTier || meW.premKind || 'premium').toLowerCase() : '');
      const rW: any = await getByKey(db, 'AirConnectSettings', 'wcmin:' + node); /* v62 targeted */
      let mW: any = {}; try { mW = rW ? JSON.parse(rW.v) : {}; } catch { mW = {}; }
      const mo = new Date().toISOString().slice(0, 7);
      if (tierW === 'premium' && mW.gmo !== mo) { mW.gmo = mo; mW.bal = Number(mW.bal || 0) + 3600; } /* Premium: 60 free minutes every month */
      if (rW) await updateRec(db, 'AirConnectSettings', rW.id, { v: JSON.stringify(mW) });
      else await db.entities.AirConnectSettings.create({ k: 'wcmin:' + node, v: JSON.stringify(mW) });
      return json({ ok: true, tier: tierW, bal: Math.round(Number(mW.bal || 0)), unit: 'sec' });
    }
    if (a === 'wctop') { /* owner-verified top-up: 15 min = 8000, 30 min = 15000, 60 min = 30000 naira (skylar-approved bundles) */
      const num = String(b.num || ''), mins = Number(b.mins || 0), sig = String(b.sig || '');
      if (!/^\d{9,12}$/.test(num) || ![15, 30, 60].includes(mins)) return json({ err: 'invalid top-up' }, 400);
      const bufW = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('acX9-premium-v13|wctop|' + num + '|' + mins));
      const chkW = [...new Uint8Array(bufW)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 8);
      if (sig !== chkW) return json({ err: 'invalid signature' }, 403);
      const rW: any = await getByKey(db, 'AirConnectSettings', 'wcmin:' + num); /* v62 targeted */
      let mW: any = {}; try { mW = rW ? JSON.parse(rW.v) : {}; } catch { mW = {}; }
      mW.bal = Number(mW.bal || 0) + mins * 60;
      if (rW) await updateRec(db, 'AirConnectSettings', rW.id, { v: JSON.stringify(mW) });
      else await db.entities.AirConnectSettings.create({ k: 'wcmin:' + num, v: JSON.stringify(mW) });
      return json({ ok: true, bal: Math.round(mW.bal) });
    }
    if (a === 'wcall') { /* v82: dial ANY number in the world (Twilio bridge). Fully metered; needs the Twilio line connected (env secrets). */
      const from = String(b.from || ''), to = String(b.to || '').replace(/[^+\d]/g, '');
      if (!/^\d{9,12}$/.test(from) || !/^\+?\d{8,15}$/.test(to)) return json({ err: 'invalid number' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const meW: any = st.nodes.find((n: any) => n.number === from);
      const actW = !!(meW && meW.premExp && new Date(meW.premExp) > new Date());
      const tierW = from === '234100000001' ? 'premium' : (actW ? String(meW.premTier || meW.premKind || 'premium').toLowerCase() : '');
      if (!['ultra', 'premium'].includes(tierW)) return json({ err: 'World calling unlocks from the Ultra plan — open 💎 Premium plans in the menu' }, 402);
      const rW: any = await getByKey(db, 'AirConnectSettings', 'wcmin:' + from); /* v62 targeted */
      let mW: any = {}; try { mW = rW ? JSON.parse(rW.v) : {}; } catch { mW = {}; }
      const mo = new Date().toISOString().slice(0, 7);
      if (tierW === 'premium' && mW.gmo !== mo) { mW.gmo = mo; mW.bal = Number(mW.bal || 0) + 3600; }
      if (Number(mW.bal || 0) < 30) return json({ err: 'Not enough call minutes — top up in 💎 Premium plans (15 min ₦8,000 · 30 min ₦15,000 · 60 min ₦30,000)', bal: Math.round(Number(mW.bal || 0)) }, 402);
      if (!(env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM)) {
        return json({ ok: false, err: 'World calling switches on the moment the phone line is connected — your minutes are safe and waiting 🌍', bal: Math.round(Number(mW.bal || 0)) });
      }
      /* Twilio funded: place the real outbound call — target hears the owner's AI agent greeting and can leave a message the agent transcribes */
      try {
        const twUrl = 'https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_SID + '/Calls.json';
        const body = 'To=' + encodeURIComponent(to) + '&From=' + encodeURIComponent(env.TWILIO_FROM) + '&Url=' + encodeURIComponent('https://airconnect-api.successeverydayww-cpu.workers.dev/?act=wtwiml&u=' + from);
        const auth = btoa(env.TWILIO_SID + ':' + env.TWILIO_TOKEN);
        const rTw = await fetch(twUrl, { method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        if (!rTw.ok) return json({ err: 'call could not be placed — try again' }, 502);
        mW.bal = Number(mW.bal || 0) - 30; /* reserve 30s on dial; reconciled when the call report lands */
        if (rW) await updateRec(db, 'AirConnectSettings', rW.id, { v: JSON.stringify(mW) });
        else await db.entities.AirConnectSettings.create({ k: 'wcmin:' + from, v: JSON.stringify(mW) });
        return json({ ok: true, bal: Math.round(mW.bal), msg: 'Calling ' + to + ' — the meter runs while you talk' });
      } catch (e: any) { return json({ err: 'call failed — check the number' }, 502); }
    }
    /* v83: GROUP LANGUAGE PLAN — $3/₦4,800 a month per group (skylar 21 Sep): live translated group calls + messages in every member's chosen language */
    if (a === 'gplanset') {
      const gid = String(b.gid || ''), sig = String(b.sig || ''), days = Number(b.days) || 30;
      if (!gid || !sig) return json({ err: 'invalid' }, 400);
      const bufG = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('acX9-premium-v13|gplan|' + gid + '|' + days));
      const chkG = [...new Uint8Array(bufG)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 8);
      if (sig !== chkG) return json({ err: 'invalid signature' }, 403);
      const st = await loadState(db);
      const grp: any = st.groups.find((g: any) => g.id === gid);
      if (!grp) return json({ err: 'group not found' }, 404);
      grp.gplanExp = new Date(Date.now() + days * 86400000).toISOString();
      await saveState(db, st);
      try { await pushNotify(db, st, String(grp.by), { what: 'chat', from: grp.by, fromName: 'AirConnect', text: '🌍 Group Language Plan ACTIVE for ' + grp.name + ' — group calls and messages now reach every member in their own chosen language.' }); } catch (e: any) {}
      return json({ ok: true, gplanExp: grp.gplanExp });
    }
    if (a === 'gnudgewk') { /* v83: weekly nudge to group creators without the Language Plan — called by the bridge cron, guarded weekly */
      const wk = new Date().toISOString().slice(0, 8) + '-W' + String(Math.ceil((Date.now() / 86400000 + 4) / 7));
      const rW: any = await getByKey(db, 'AirConnectSettings', 'gnudgewk:last'); /* v62 targeted */
      let last = ''; try { last = rW ? String(JSON.parse(rW.v).wk || '') : ''; } catch { last = ''; }
      if (last === wk) return json({ ok: true, skipped: true });
      const st = await loadState(db);
      const seenC = new Set<string>();
      let sent = 0;
      for (const g of st.groups) {
        if (g.gplanExp && new Date(g.gplanExp) > new Date()) continue;
        if (String(g.by) === '234100000001') continue;
        if (seenC.has(String(g.by))) continue;
        if (Date.now() - new Date(g.created).getTime() < 3 * 86400000) continue;
        seenC.add(String(g.by));
        try { await pushNotify(db, st, String(g.by), { what: 'chat', from: String(g.by), fromName: 'AirConnect', text: '🌍 Your group ' + g.name + ' can talk across languages! Add the Group Language Plan — every member hears group calls and reads messages in their own language. Just $3 (₦4,800) a month. Open the group, tap its name, then tap the Language Plan.' }); sent++; } catch (e: any) {}
      }
      const nv = JSON.stringify({ wk });
      if (rW) await updateRec(db, 'AirConnectSettings', rW.id, { v: nv });
      else await db.entities.AirConnectSettings.create({ k: 'gnudgewk:last', v: nv });
      return json({ ok: true, sent });
    }
    if (a === 'isprem') { /* v71: Premium check for the mesh-bridge (full agent powers) */
      const num = String(b.num || '');
      if (!/^\d{9,12}$/.test(num)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      const me: any = st.nodes.find((n: any) => n.number === num);
      const act = !!(me && me.premExp && new Date(me.premExp) > new Date());
      const premium = num === '234100000001' || act;
      const tier = num === '234100000001' ? 'premium' : (act ? String(me.premTier || me.premKind || 'premium') : '');
      return json({ ok: true, premium, tier, lang: (me && me.lang) || '' });
    }
    if (a === 'ppset') { /* v75: change passphrase — current passphrase required */
      const from = String(b.from || ''), aid = String(b.aid || '');
      const cur = String(b.cur || '').trim().toLowerCase().slice(0, 120);
      const nw = String(b.nw || '').trim().toLowerCase().slice(0, 120);
      if (!/^\d{9,12}$/.test(from)) return json({ err: 'invalid' }, 400);
      if (nw.length < 8) return json({ err: 'new passphrase too short — use at least 8 characters' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, from)) return json({ err: 'banned' }, 403);
        const me: any = st.nodes.find((n: any) => n.number === from);
        if (!me || String(me.aid || '') !== aid) return json({ err: 'not authorized' }, 403);
        if (!me.phrase || String(me.phrase || '').toLowerCase() !== cur) return json({ err: 'current passphrase is wrong' }, 403);
        me.phrase = nw;
        trimState(st); await saveState(db, st);
        return json({ ok: true, phrase: me.phrase });
      }
      return json({ err: 'conflict, try again' }, 503);
    }
    if (a === 'meset') { /* v70: WhatsApp-style profile editing — name + about */
      const from = String(b.from || ''), aid = String(b.aid || '');
      const name = b.name !== undefined ? sanitize(String(b.name), 60) : undefined;
      const about = b.about !== undefined ? sanitize(String(b.about), 300) : undefined;
      const lang = b.lang !== undefined ? sanitize(String(b.lang), 5) : undefined;
      if (!/^\d{9,12}$/.test(from)) return json({ err: 'invalid' }, 400);
      if (name === '' && about === undefined && lang === undefined) return json({ err: 'nothing to change' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, from)) return json({ err: 'banned' }, 403);
        const me: any = st.nodes.find((n: any) => n.number === from);
        if (!me || String(me.aid || '') !== aid) return json({ err: 'not authorized' }, 403);
        if (name) me.name = name;
        if (about !== undefined) me.about = about;
        if (lang) me.lang = lang;
        trimState(st); await saveState(db, st);
        return json({ ok: true, name: me.name, about: me.about || '' });
      }
      return json({ err: 'conflict, try again' }, 503);
    }
    if (a === 'pic') {
      const node = String(b.node || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const rec: any = await getByKey(db, 'AirConnectSettings', 'pic:' + node); /* v62 targeted */
      return json({ pic: (rec && rec.v) || '' });
    }

    /* ---------- v121 (skylar): group profile photo/avatar — admin-uploadable, same storage pattern as personal avatar ---------- */
    if (a === 'gavatar') { // admin sets the group's photo
      const by = String(b.by || ''), g = String(b.g || ''), pic = String(b.pic || '');
      if (!/^\d{9,12}$/.test(by) || !g) return json({ err: 'invalid' }, 400);
      if (pic && (!/^data:image\/(jpeg|png|webp);base64,/.test(pic) || pic.length > 45000))
        return json({ err: 'photo too large or invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, by)) return json({ err: 'banned' }, 403);
        const grp: any = (st.groups || []).find((x: any) => x.id === g);
        if (!grp || (grp.members || []).indexOf(by) < 0) return json({ err: 'not a member' }, 403);
        const admins = grp.admins || [grp.by];
        if (admins.indexOf(by) < 0) return json({ err: 'admins only' }, 403);
        const rec: any = await getByKey(db, 'AirConnectSettings', 'gpic:' + g); /* targeted, no full scan */
        if (rec) await updateRec(db, 'AirConnectSettings', rec.id, { v: pic });
        else await db.entities.AirConnectSettings.create({ k: 'gpic:' + g, v: pic });
        return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }
    if (a === 'gpic') { // fetch a group's photo
      const g = String(b.g || '');
      if (!g) return json({ err: 'invalid' }, 400);
      const rec: any = await getByKey(db, 'AirConnectSettings', 'gpic:' + g);
      return json({ pic: (rec && rec.v) || '' });
    }

    /* ---------- v41b: YouTube-style channel creation with email verification ---------- */
    if (a === 'chanreq') {
      const from = String(b.from || ''), name = sanitize(b.name, 60), about = sanitize(b.about, 300), email = String(b.email || '').slice(0, 254);
      if (!/^\d{9,12}$/.test(from) || !name) return json({ err: 'invalid' }, 400);
      if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) return json({ err: 'invalid email' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const reqk = 'chanreq:' + from; /* v62 targeted */
      const prior: any = await getByKey(db, 'AirConnectSettings', reqk);
      if (prior) {
        let pv: any; try { pv = JSON.parse(prior.v); } catch { pv = {}; }
        if (Date.now() - Number(pv.at || 0) < 60000) return json({ err: 'Please wait a minute before requesting another code' }, 429);
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await db.entities.AirConnectSettings.create({ k: reqk + ':new', v: JSON.stringify({ name, about, email, code, at: Date.now(), tries: 0 }) });
      /* deliver code via AirConnect superagent email service (Brevo) */
      let sent = false;
      try {
        const er = await fetch('https://superagent-ccb075d2.base44.app/functions/channelVerify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tk: 'air-chan-9f27e0b4d6a15c38', num: from, email, code, name }) });
        sent = er.ok;
      } catch (e) {}
      /* atomically replace prior request with the new one */
      const prior2: any = await getByKey(db, 'AirConnectSettings', reqk); /* v62 targeted */
      const fresh: any = await getByKey(db, 'AirConnectSettings', reqk + ':new');
      if (prior2) await delRec(db, 'AirConnectSettings', prior2.id);
      if (fresh) await updateRec(db, 'AirConnectSettings', fresh.id, { k: reqk });
      if (!sent) return json({ err: 'Could not send the email — check the address and try again' }, 502);
      const masked = email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
      return json({ ok: true, masked });
    }

    if (a === 'chanverify') {
      const from = String(b.from || ''), code = String(b.code || '');
      if (!/^\d{9,12}$/.test(from) || !/^\d{6}$/.test(code)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const req: any = await getByKey(db, 'AirConnectSettings', 'chanreq:' + from); /* v62 targeted */
      if (!req) return json({ err: 'No pending request — request a code first' }, 404);
      let rv: any; try { rv = JSON.parse(req.v); } catch { return json({ err: 'corrupt request' }, 403); }
      const tries = Number(rv.tries || 0);
      if (tries >= 5) { await delRec(db, 'AirConnectSettings', req.id); return json({ err: 'Too many wrong codes — request a new code' }, 429); }
      if (String(rv.code) !== code) {
        await updateRec(db, 'AirConnectSettings', req.id, { v: JSON.stringify({ ...rv, tries: tries + 1 }) });
        return json({ err: 'Wrong code' }, 400);
      }
      /* create the channel with the verified details */
      const meNode: any = st.nodes.find((n: any) => n.number === from);
      const ck = 'chan:' + from;
      const ex: any = await getByKey(db, 'AirConnectSettings', ck); /* v62 targeted */
      if (ex) {
        await updateRec(db, 'AirConnectSettings', ex.id, { v: JSON.stringify({ num: from, name: sanitize(rv.name, 60), about: sanitize(rv.about || '', 300), at: Date.now() }) });
      } else {
        await db.entities.AirConnectSettings.create({ k: ck, v: JSON.stringify({ num: from, name: sanitize(rv.name, 60), about: sanitize(rv.about || '', 300), at: Date.now() }) });
      }
      await delRec(db, 'AirConnectSettings', req.id);
      return json({ ok: true });
    }

    /* ---------- v12: recall, reactions, export, account deletion, groups, analytics ---------- */
    if (a === 'msgdel') { // delete for everyone (sender only, 24h window)
      const from = String(b.from || ''), id = String(b.id || '');
      if (!/^\d{9,12}$/.test(from) || !id) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, from)) return json({ err: 'banned' }, 403);
        const m: any = st.msgs.find((x: any) => x.created === id && x.fromNum === from);
        if (!m) return json({ err: 'not found' }, 403);
        if (Date.now() - new Date(id).getTime() > 24 * 3600 * 1000) return json({ err: 'window expired' }, 403);
        const oldText = m.text;
        m.text = '[deleted]';
        trimState(st);
        await saveState(db, st);
        try { // also purge the permanent history row
          const rows = await listWhere(db, 'AirConnectMessage', 'fromNum = ? AND text = ?', [from, oldText]); /* v62 targeted */
          const targets = rows;
          for (const r of targets) { try { await db.entities.AirConnectMessage.delete(r.id); } catch (e) {} }
        } catch (e) {}
        return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    /* ---------- v153 (skylar): unsend & edit — WhatsApp 'delete for everyone' + edit.
       Hardened: real D1 columns in the WHERE (created_at), strict row match on
       (created_date = id AND fromNum = sender), and the write is VERIFIED before
       ok is returned — a failed update can never silently report success. */
    if (a === 'unsend' || a === 'editmsg') {
      const by = String(b.by || ''), peer = String(b.peer || ''), id = String(b.id || '');
      const newText = a === 'editmsg' ? String(b.text || '') : '';
      if (!/^\d{9,12}$/.test(by) || !/^\d{9,12}$/.test(peer) || by === peer || !/^\d{4}-\d{2}-\d{2}T/.test(id)) return json({ err: 'invalid' }, 400);
      if (a === 'editmsg' && (!newText || newText.length > 4000)) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, by)) return json({ err: 'banned' }, 403);
        const pair = [by, peer].sort();
        if (!st.friends.some((f: any) => f.a === pair[0] && f.b === pair[1])) return json({ err: 'not friends' }, 403);
        const rows = await listWhere(db, 'AirConnectMessage', '(fromNum = ? AND toNum = ?) OR (fromNum = ? AND toNum = ?)', [by, peer, peer, by]);
        const row: any = (rows || []).find((m: any) => String(m.created_date) === id && String(m.fromNum) === by && (String(m.toNum) === peer));
        if (!row) return json({ err: 'not found' }, 404);
        const tombstone = a === 'editmsg' ? ('ed1:' + newText.slice(0, 4000)) : 'ac:unsent';
        if (a === 'editmsg') {
          const ageMin = (Date.now() - new Date(row.created_date).getTime()) / 60000;
          if (ageMin > 15) return json({ err: 'edit window expired' }, 403);
        }
        let wrote = false;
        try { await db.entities.AirConnectMessage.update(row.id, { text: tombstone }); } catch (e) {}
        try { const chk: any = await db.entities.AirConnectMessage.get(row.id); if (chk && String(chk.text) === tombstone) wrote = true; } catch (e) {}
        if (!wrote) return json({ err: 'could not update message — try again' }, 500);
        const live: any = st.msgs.find((x: any) => x.created === id && x.fromNum === by);
        if (live) live.text = tombstone;
        st.msgs.push({ id: rid(), fromNum: by, toNum: peer, created: new Date().toISOString(),
          text: a === 'editmsg' ? ('edm:' + id + '|' + tombstone) : ('usm:' + id) });
        trimState(st);
        await saveState(db, st);
        return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'react') { // tap a reaction on any chat message
      const by = String(b.by || ''), id = String(b.id || ''), e = String(b.e || '').slice(0, 8);
      if (!/^\d{9,12}$/.test(by) || !id) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, by)) return json({ err: 'banned' }, 403);
        const m: any = st.msgs.find((x: any) => x.created === id) || st.gmsgs.find((x: any) => x.id === id);
        let msg: any = m;
        if (!msg) { /* v69: message slid out of the live window — validate via reaction index */
          const rx: any = (st.ridx || []).find((x: any) => x.id === id);
          if (!rx) return json({ err: 'not found' }, 404);
          msg = rx.g !== undefined ? { g: rx.g } : { fromNum: rx.f, toNum: rx.t };
        }
        if (msg.g !== undefined) { // group message: any group member may react
          const grp = st.groups.find((g: any) => g.id === msg.g);
          if (grp && (grp.members || []).indexOf(by) < 0) return json({ err: 'not your chat' }, 403);
        } else if (by !== msg.fromNum && by !== msg.toNum) return json({ err: 'not your chat' }, 403);
        st.reacts = (st.reacts || []).filter((x: any) => !(x.id === id && x.by === by));
        if (e) st.reacts.push({ id, by, e, at: new Date().toISOString() });
        trimState(st);
        await saveState(db, st);
        return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'export') { // user's data, their way, anytime
      const node = String(b.node || '');
      if (!/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const me: any = st.nodes.find((n: any) => n.number === node);
      const friends = st.friends.filter((f: any) => f.a === node || f.b === node)
        .map((f: any) => (f.a === node ? f.b : f.a));
      const msgs = st.msgs.filter((m: any) => m.fromNum === node || m.toNum === node);
      let history: any[] = [];
      try {
        const rows = await listWhere(db, 'AirConnectMessage', 'fromNum = ? OR toNum = ?', [node, node]); /* v62 targeted */
        history = rows.filter((m: any) => m.fromNum === node || m.toNum === node)
          .map((m: any) => ({ at: m.created_date, from: m.fromNum, to: m.toNum, text: m.text }))
          .sort((x: any, y: any) => (x.at < y.at ? -1 : 1));
      } catch (e) {}
      const dayAgo = Date.now() - 86400000;
      let stories = 0;
      try {
        stories = await countWhere(db, 'AirConnectSettings', "k LIKE 'story:' || ? || ':%:done' AND CAST(SUBSTR(k, LENGTH('story:' || ? || ':') + 1, INSTR(SUBSTR(k, LENGTH('story:' || ? || ':') + 1), ':') - 1) AS INTEGER) > ?", [node, node, node, Math.floor(dayAgo / 1000) * 0 + Math.floor(dayAgo)]); /* v62 targeted count */
      } catch (e) {}
      return json({
        profile: me ? { number: me.number, name: me.name, country: me.country, created: me.created } : null,
        friends, archived_messages: history, recent_messages: msgs, active_statuses: stories, exported_at: new Date().toISOString(),
      });
    }

    if (a === 'account_del') { // GDPR-style erasure: purge everything about this user
      const node = String(b.node || '');
      const phraseIn = String(b.phrase || '').trim().toLowerCase().slice(0, 120);
      if (!/^\d{9,12}$/.test(node) || String(b.confirm || '') !== 'DELETE') return json({ err: 'confirm required' }, 400);
      if (node === '234100000001') return json({ err: 'the owner account cannot be deleted' }, 403);
      if (!phraseIn) return json({ err: 'passphrase required' }, 400);
      { /* v85: his directive — passphrase must be verified before any deletion */
        const st0 = await loadState(db);
        const me0: any = st0.nodes.find((n: any) => n.number === node);
        if (!me0) return json({ err: 'account not found' }, 404);
        if (!me0.phrase || String(me0.phrase || '').toLowerCase() !== phraseIn) return json({ err: 'passphrase is wrong' }, 403);
      }
      let erased = false;
      for (let attempt = 0; attempt < 3 && !erased; attempt++) {
        const st = await loadState(db);
        st.nodes = st.nodes.filter((n: any) => n.number !== node);
        st.friends = st.friends.filter((f: any) => f.a !== node && f.b !== node);
        st.requests = st.requests.filter((r: any) => r.fromNum !== node && r.toNum !== node);
        st.msgs = st.msgs.filter((m: any) => m.fromNum !== node && m.toNum !== node);
        st.sigs = st.sigs.filter((s: any) => s.fromNum !== node && s.toNum !== node);
        st.subs = st.subs.filter((s: any) => s.num !== node);
        st.blocks = st.blocks.filter((x: any) => x.by !== node && x.who !== node);
        st.groups = (st.groups || []).map((g: any) => ({ ...g, members: (g.members || []).filter((m: string) => m !== node) })).filter((g: any) => (g.members || []).length > 1);
        st.gmsgs = (st.gmsgs || []).filter((x: any) => x.from !== node);
        st.reacts = (st.reacts || []).filter((x: any) => x.by !== node);
        st.otps = st.otps || {}; st.verif = st.verif || {};
        for (const k of Object.keys(st.otps)) if (k === node || k === 'e:' + node) delete st.otps[k];
        for (const k of Object.keys(st.verif)) if (k === node || k === 'e:' + node) delete st.verif[k];
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db); // VERIFY the erasure actually landed
        erased = !chk.nodes.some((n: any) => n.number === node)
          && !chk.friends.some((f: any) => f.a === node || f.b === node)
          && !chk.subs.some((s: any) => s.num === node);
      }
      if (!erased) return json({ err: 'could not complete — try again in a minute' }, 503);
      // history + media rows are best-effort: the identity is already erased above
      try {
        const mine = await listWhere(db, 'AirConnectMessage', 'fromNum = ? OR toNum = ?', [node, node]); /* v62 targeted */
        for (const r of mine) { try { await db.entities.AirConnectMessage.delete(r.id); } catch (e) {} }
      } catch (e) {}
      try {
        const rows2 = await listByPrefix(db, 'AirConnectSettings', ['story:' + node + ':', 'pic:' + node]); /* v62 targeted */
        await purgeByPrefix(db, 'AirConnectSettings', rows2, (k) => k.startsWith('story:' + node + ':') || k === 'pic:' + node);
      } catch (e) {}
      return json({ ok: true, verified: true });
    }

    if (a === 'gcreate') { // create a group (Telegram-cloud style: server-side messages)
      const by = String(b.by || ''), name = sanitize(b.name, 40);
      let members = Array.isArray(b.members) ? b.members.map(String).filter((x: string) => /^\d{9,12}$/.test(x)) : [];
      members = Array.from(new Set([by, ...members]));
      if (!/^\d{9,12}$/.test(by) || !name || members.length < 2) return json({ err: 'need a name and at least one friend' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, by)) return json({ err: 'banned' }, 403);
        const gCutoff = new Date(Date.now() - 60000).toISOString();
        if (st.groups.filter((g: any) => g.by === by && g.created > gCutoff).length >= 3)
          return json({ err: 'too many groups — slow down' }, 429);
        for (const m of members) if (!st.nodes.find((n: any) => n.number === m)) return json({ err: 'unknown member ' + m }, 404); /* v59 (skylar): say WHICH member so the client can drop exactly that one during old-group migration */
        const id = 'g' + rid();
        st.groups.push({ gplan: !!b.gplan,  id, name, by, members, admins: [by], created: new Date().toISOString(),
          pass: sanitize(String(b.pass || ''), 40), lock: b.lock ? 1 : 0, perm: b.perm ? 1 : 0, past: [], reqs: [] });
        /* v78: everyone in a group becomes friends automatically (skylar directive) */
        for (const x of members) for (const y of members) { if (x === y) continue; const p2 = [x, y].sort();
          if (!st.friends.some((f: any) => f.a === p2[0] && f.b === p2[1])) st.friends.push({ a: p2[0], b: p2[1] }); }
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        if ((chk.groups || []).some((g: any) => g.id === id)) {
          for (const m of members) if (m !== by) await pushNotify(db, chk, m, { what: 'group', from: by, group: name });
          return json({ ok: true, id, name, members });
        }
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'gbackfill') { /* v59 (skylar): one-time import of old-engine local group messages so reactions and history work on the new engine */
      const by = String(b.by || ''), g = String(b.g || '');
      const msgs = Array.isArray(b.msgs) ? b.msgs.slice(0, 80) : [];
      if (!/^\d{9,12}$/.test(by) || !g || !msgs.length) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, by)) return json({ err: 'banned' }, 403);
        const grp: any = st.groups.find((x: any) => x.id === g);
        if (!grp || (grp.members || []).indexOf(by) < 0) return json({ err: 'not a member' }, 403);
        const have = new Set(st.gmsgs.map((x: any) => x.id));
        let n = 0;
        for (const m of msgs) {
          const id = String((m && m.id) || ''), from = String((m && m.from) || ''), text = sanitize(String((m && m.text) || ''), 4000);
          if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(id) || !text) continue;
          if ((grp.members || []).indexOf(from) < 0) continue;
          if (have.has(id)) continue;
          st.gmsgs.push({ id, g, from, text });
          have.add(id); n++;
        }
        if (!n) return json({ ok: true, added: 0 });
        st.gmsgs.sort((x: any, y: any) => (x.id < y.id ? -1 : 1));
        trimState(st); await saveState(db, st);
        const chk = await loadState(db);
        if (msgs.some((m: any) => (chk.gmsgs || []).some((x: any) => x.id === String(m.id)))) return json({ ok: true, added: n });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'gmsg') {
      const from = String(b.from || ''), g = String(b.g || '');
      const text = sanitize(b.text, 2000);
      if (!/^\d{9,12}$/.test(from) || !g || !text) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, from)) return json({ err: 'banned' }, 403);
        const grp: any = (st.groups || []).find((x: any) => x.id === g);
        if (!grp || (grp.members || []).indexOf(from) < 0) return json({ err: 'not a member' }, 403);
        if (grp.lock && (grp.admins || [grp.by]).indexOf(from) < 0) return json({ err: '🔒 the admin has locked this group — only admins can send' }, 403);
        const gCutoff = new Date(Date.now() - 60000).toISOString();
        if (st.gmsgs.filter((x: any) => x.from === from && x.created > gCutoff).length > 20) {
          return json({ err: 'sending too fast — pause a moment' }, 429); /* v171: throttle, never ban */
        }
        const now = new Date().toISOString();
        st.gmsgs.push({ id: now, g, from, text, created: now });
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        if ((chk.gmsgs || []).some((x: any) => x.id === now)) {
          for (const m of grp.members) if (m !== from) await pushNotify(db, chk, m, { what: 'chat', from, fromName: 'group: ' + grp.name, text: text.slice(0, 60) });
          return json({ ok: true, id: now });
        }
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'gleave') {
      const node = String(b.node || ''), g = String(b.g || '');
      if (!/^\d{9,12}$/.test(node) || !g) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        const grp: any = (st.groups || []).find((x: any) => x.id === g);
        if (!grp) return json({ err: 'not found' }, 404);
        grp.members = (grp.members || []).filter((m: string) => m !== node);
        grp.past = (grp.past || []).filter((p: any) => p.n !== node); grp.past.push({ n: node, at: Date.now(), how: 'left' });
        st.groups = st.groups.filter((x: any) => (x.members || []).length > 1);
        trimState(st);
        await saveState(db, st);
        return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'ginfo') { // WhatsApp-style group info
      const node = String(b.node || ''), g = String(b.g || '');
      if (!/^\d{9,12}$/.test(node) || !g) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      const grp: any = (st.groups || []).find((x: any) => x.id === g);
      if (!grp) return json({ err: 'not found' }, 404);
      if ((grp.members || []).indexOf(node) < 0)
        return json({ ok: true, peek: true, id: grp.id, name: grp.name, memCount: (grp.members || []).length, perm: grp.perm ? 1 : 0 }); /* v78: link preview for joiners */
      const admins = grp.admins || [grp.by];
      const mem = (grp.members || []).map((m: string) => {
        const n: any = st.nodes.find((x: any) => x.number === m);
        return { id: m, name: n ? n.name : 'unknown', admin: admins.indexOf(m) >= 0, creator: m === grp.by };
      });
      const past = (grp.past || []).map((p: any) => {
        const n: any = st.nodes.find((x: any) => x.number === p.n);
        return { id: p.n, name: n ? n.name : 'unknown', how: p.how, at: p.at };
      });
      const iAmAdmin = admins.indexOf(node) >= 0;
      const reqs = iAmAdmin ? (grp.reqs || []).map((q: any) => {
        const n: any = st.nodes.find((x: any) => x.number === q.n);
        return { id: q.n, name: n ? n.name : 'unknown', at: q.at };
      }) : [];
      return json({ ok: true, id: grp.id, name: grp.name, by: grp.by, members: mem, created: grp.created,
        past, reqs, lock: grp.lock ? 1 : 0, perm: grp.perm ? 1 : 0, iAmAdmin,
        pass: iAmAdmin ? (grp.pass || '') : undefined, hasPass: !!grp.pass });
    }

    if (a === 'gadd') { // admin adds friends
      const by = String(b.by || ''), g = String(b.g || '');
      let members = Array.isArray(b.members) ? b.members.map(String).filter((x: string) => /^\d{9,12}$/.test(x)) : [];
      members = Array.from(new Set(members));
      if (!/^\d{9,12}$/.test(by) || !g || !members.length) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, by)) return json({ err: 'banned' }, 403);
        const grp: any = (st.groups || []).find((x: any) => x.id === g);
        if (!grp || (grp.members || []).indexOf(by) < 0) return json({ err: 'not a member' }, 403);
        const admins = grp.admins || [grp.by];
        if (admins.indexOf(by) < 0) return json({ err: 'admins only' }, 403);
        for (const m of members) if (!st.nodes.find((n: any) => n.number === m)) return json({ err: 'unknown number ' + m }, 404);
        const before = (grp.members || []).slice();
        grp.members = Array.from(new Set((grp.members || []).concat(members)));
        /* v78: a new member automatically becomes friends with every member (directive) */
        for (const m of members) for (const x of before) { if (m === x) continue; const p2 = [m, x].sort();
          if (!st.friends.some((f: any) => f.a === p2[0] && f.b === p2[1])) st.friends.push({ a: p2[0], b: p2[1] }); }
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        const cg: any = (chk.groups || []).find((x: any) => x.id === g);
        if (cg && members.every((m) => (cg.members || []).indexOf(m) >= 0)) {
          for (const m of members) if (m !== by) await pushNotify(db, chk, m, { what: 'group', from: by, group: cg.name });
          return json({ ok: true, members: cg.members, name: cg.name });
        }
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'gkick') { // admin removes a member
      const by = String(b.by || ''), g = String(b.g || ''), node = String(b.node || '');
      if (!/^\d{9,12}$/.test(by) || !g || !/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, by)) return json({ err: 'banned' }, 403);
        const grp: any = (st.groups || []).find((x: any) => x.id === g);
        if (!grp || (grp.members || []).indexOf(by) < 0) return json({ err: 'not a member' }, 403);
        const admins = grp.admins || [grp.by];
        if (admins.indexOf(by) < 0) return json({ err: 'admins only' }, 403);
        if (node === grp.by) return json({ err: 'cannot remove the creator' }, 403);
        grp.members = (grp.members || []).filter((m: string) => m !== node);
        grp.admins = (grp.admins || [grp.by]).filter((m: string) => m !== node);
        grp.past = (grp.past || []).filter((p: any) => p.n !== node); grp.past.push({ n: node, at: Date.now(), how: 'removed' });
        st.groups = st.groups.filter((x: any) => (x.members || []).length > 1);
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        const cg: any = (chk.groups || []).find((x: any) => x.id === g);
        if (!cg || (cg.members || []).indexOf(node) < 0) return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'gadmin') { // creator promotes / demotes admins (WhatsApp style)
      const by = String(b.by || ''), g = String(b.g || ''), node = String(b.node || ''), make = !!b.make;
      if (!/^\d{9,12}$/.test(by) || !g || !/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, by)) return json({ err: 'banned' }, 403);
        const grp: any = (st.groups || []).find((x: any) => x.id === g);
        if (!grp || grp.by !== by) return json({ err: 'creator only' }, 403);
        if ((grp.members || []).indexOf(node) < 0) return json({ err: 'not a member' }, 404);
        const admins = Array.from(new Set(grp.admins || [grp.by]));
        grp.admins = make ? admins.concat([node]) : admins.filter((x: string) => x !== node);
        if (grp.admins.indexOf(grp.by) < 0) grp.admins.unshift(grp.by);
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        const cg: any = (chk.groups || []).find((x: any) => x.id === g);
        if (cg) return json({ ok: true, admins: cg.admins || [cg.by] });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'gjoin') { /* v78: join via group link — open groups join instantly, approval groups create a request */
      const node = String(b.node || ''), g = String(b.g || '');
      if (!/^\d{9,12}$/.test(node) || !g) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, node)) return json({ err: 'banned' }, 403);
        const grp: any = (st.groups || []).find((x: any) => x.id === g);
        if (!grp) return json({ err: 'group not found' }, 404);
        if ((grp.members || []).indexOf(node) >= 0) return json({ ok: true, joined: true });
        if (!grp.perm) {
          const before = (grp.members || []).slice();
          grp.members = Array.from(new Set((grp.members || []).concat([node])));
          for (const x of before) { const p2 = [node, x].sort();
            if (!st.friends.some((f: any) => f.a === p2[0] && f.b === p2[1])) st.friends.push({ a: p2[0], b: p2[1] }); }
          trimState(st); await saveState(db, st);
          const chk = await loadState(db);
          const cg: any = (chk.groups || []).find((x: any) => x.id === g);
          if (cg && (cg.members || []).indexOf(node) >= 0) {
            for (const m of cg.members) if (m !== node) await pushNotify(db, chk, m, { what: 'group', from: node, group: cg.name });
            return json({ ok: true, joined: true });
          }
        } else {
          grp.reqs = (grp.reqs || []).filter((q: any) => q.n !== node); grp.reqs.push({ n: node, at: Date.now() });
          trimState(st); await saveState(db, st);
          const chk = await loadState(db);
          const cg: any = (chk.groups || []).find((x: any) => x.id === g);
          if (cg && (cg.reqs || []).some((q: any) => q.n === node)) {
            const admins = cg.admins || [cg.by];
            for (const adm of admins) await pushNotify(db, chk, adm, { what: 'chat', from: node, fromName: (st.nodes.find((n: any) => n.number === node) || { name: 'Someone' }).name, text: '\uD83D\uDD14 ' + cg.name + ': someone requested to join — approve in group info' });
            return json({ ok: true, requested: true });
          }
        }
      }
      return json({ err: 'conflict, try again' }, 503);
    }
    if (a === 'grq') { /* v78: admin approves/denies a join request */
      const by = String(b.by || ''), g = String(b.g || ''), node = String(b.node || ''), ok = !!b.ok;
      if (!/^\d{9,12}$/.test(by) || !g || !/^\d{9,12}$/.test(node)) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        const grp: any = (st.groups || []).find((x: any) => x.id === g);
        if (!grp) return json({ err: 'not found' }, 404);
        if (((grp.admins || [grp.by]).indexOf(by) < 0) || (grp.reqs || []).every((q: any) => q.n !== node)) return json({ err: 'nothing to approve' }, 403);
        grp.reqs = (grp.reqs || []).filter((q: any) => q.n !== node);
        if (ok) {
          const before = (grp.members || []).slice();
          grp.members = Array.from(new Set((grp.members || []).concat([node])));
          for (const x of before) { const p2 = [node, x].sort();
            if (!st.friends.some((f: any) => f.a === p2[0] && f.b === p2[1])) st.friends.push({ a: p2[0], b: p2[1] }); }
        }
        trimState(st); await saveState(db, st);
        const chk = await loadState(db);
        const cg: any = (chk.groups || []).find((x: any) => x.id === g);
        if (cg && (cg.reqs || []).every((q: any) => q.n !== node)) {
          if (ok) await pushNotify(db, chk, node, { what: 'group', from: by, group: cg.name });
          return json({ ok: true });
        }
      }
      return json({ err: 'conflict, try again' }, 503);
    }
    if (a === 'gset') { /* v78: admin settings — lock chat, group password */
      const by = String(b.by || ''), g = String(b.g || '');
      const lock = b.lock === undefined ? undefined : (b.lock ? 1 : 0);
      const pass = b.pass === undefined ? undefined : sanitize(String(b.pass), 40);
      if (!/^\d{9,12}$/.test(by) || !g) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        const grp: any = (st.groups || []).find((x: any) => x.id === g);
        if (!grp || (grp.members || []).indexOf(by) < 0) return json({ err: 'not found' }, 404);
        if ((grp.admins || [grp.by]).indexOf(by) < 0) return json({ err: 'admins only' }, 403);
        if (lock !== undefined) grp.lock = lock;
        if (pass !== undefined) grp.pass = pass;
        trimState(st); await saveState(db, st);
        const chk = await loadState(db);
        const cg: any = (chk.groups || []).find((x: any) => x.id === g);
        if (cg) return json({ ok: true, lock: cg.lock ? 1 : 0, hasPass: !!cg.pass });
      }
      return json({ err: 'conflict, try again' }, 503);
    }
    if (a === 'gdel') { /* v78: admin deletes the group — password required */
      const by = String(b.by || ''), g = String(b.g || ''), pass = sanitize(String(b.pass || ''), 40);
      if (!/^\d{9,12}$/.test(by) || !g) return json({ err: 'invalid' }, 400);
      const st = await loadState(db);
      const grp: any = (st.groups || []).find((x: any) => x.id === g);
      if (!grp) return json({ err: 'not found' }, 404);
      if ((grp.admins || [grp.by]).indexOf(by) < 0) return json({ err: 'admins only' }, 403);
      if (!grp.pass) return json({ err: 'set a group password first in group settings' }, 403);
      if (String(grp.pass) !== pass) return json({ err: 'wrong group password' }, 403);
      const members = (grp.members || []).slice();
      st.groups = st.groups.filter((x: any) => x.id !== g);
      st.gmsgs = (st.gmsgs || []).filter((x: any) => x.g !== g);
      trimState(st); await saveState(db, st);
      const chk = await loadState(db);
      if (!(chk.groups || []).some((x: any) => x.id === g)) {
        for (const m of members) if (m !== by) await pushNotify(db, chk, m, { what: 'chat', from: by, fromName: grp.name, text: '\uD83D\uDED1 The group \u201C' + grp.name + '\u201D was deleted by an admin' });
        return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }
    if (a === 'flink') { /* v78: personal link — instant automatic friendship */
      const from = String(b.from || ''), num = String(b.num || '');
      if (!/^\d{9,12}$/.test(from) || !/^\d{9,12}$/.test(num) || from === num) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, from)) return json({ err: 'banned' }, 403);
        if (!st.nodes.find((n: any) => n.number === num)) return json({ err: 'that number is not on AirConnect yet' }, 404);
        const p2 = [from, num].sort();
        if (!st.friends.some((f: any) => f.a === p2[0] && f.b === p2[1])) st.friends.push({ a: p2[0], b: p2[1] });
        trimState(st); await saveState(db, st);
        const chk = await loadState(db);
        if (chk.friends.some((f: any) => f.a === p2[0] && f.b === p2[1])) return json({ ok: true });
      }
      return json({ err: 'conflict, try again' }, 503);
    }
    if (a === 'grename') { // admin renames the group
      const by = String(b.by || ''), g = String(b.g || ''), name = sanitize(b.name, 40);
      if (!/^\d{9,12}$/.test(by) || !g || !name) return json({ err: 'invalid' }, 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        if (isBanned(st, by)) return json({ err: 'banned' }, 403);
        const grp: any = (st.groups || []).find((x: any) => x.id === g);
        if (!grp || (grp.members || []).indexOf(by) < 0) return json({ err: 'not a member' }, 403);
        const admins = grp.admins || [grp.by];
        if (admins.indexOf(by) < 0) return json({ err: 'admins only' }, 403);
        grp.name = name;
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        const cg: any = (chk.groups || []).find((x: any) => x.id === g);
        if (cg && cg.name === name) return json({ ok: true, name });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'stats2') { // analytics for skylar only
      const node = String(b.node || '');
      if (node !== '234100000001') return json({ err: 'not found' }, 404);
      const st = await loadState(db);
      const dayAgo = Date.now() - 86400000;
      const byDay: Record<string, number> = {};
      for (const n of st.nodes) { const d = String(n.created || '').slice(0, 10); if (d) byDay[d] = (byDay[d] || 0) + 1; }
      let historyRows = 0;
      try { historyRows = await countWhere(db, 'AirConnectMessage', '1=1', []); } catch (e) {} /* v62 targeted count */
      let storyRows = 0;
      try { storyRows = await countWhere(db, 'AirConnectSettings', "k LIKE 'story:%:done'", []); } catch (e) {} /* v62 targeted count */
      const iso = new Date().toISOString();
      return json({
        total_users: st.nodes.length, signups_by_day: byDay,
        users_signed_up_24h: st.nodes.filter((n: any) => (n.created || '') > new Date(dayAgo).toISOString()).length,
        friend_pairs: st.friends.length, pending_requests: st.requests.filter((r: any) => (r.status || 'pending') === 'pending').length,
        active_statuses_24h: storyRows, groups: (st.groups || []).length,
        msgs_recent: st.msgs.length, group_msgs_recent: (st.gmsgs || []).length,
        chat_history_rows: historyRows, reactions: (st.reacts || []).length,
        calls_offered_24h: st.sigs.filter((s: any) => s.type === 'offer').length,
        push_subscribers: (st.subs || []).length, bans: (st.bans || []).length,
        generated: iso,
      });
    }

    if (a === 'log') {
      const st = await loadState(db);
      const logCutoff = new Date(Date.now() - 60000).toISOString();
      if (st.sigs.filter((x: any) => x.toNum === 'system' && x.created > logCutoff).length > 80)
        return json({ ok: true });
      st.sigs.push({ id: rid(), toNum: 'system', fromNum: 'log', type: 'log', payload: String(b.msg || '').slice(0, 300), created: new Date().toISOString() });
      trimState(st);
      await saveState(db, st);
      return json({ ok: true });
    }

    if (a === 'debug') {
      const st = await loadState(db);
      return json({
        bans: st.bans,
        nodes: st.nodes.map((n:any)=>({num:n.number,name:n.name})),
        requests: st.requests,
        friends: st.friends,
      });
    }

    if (a === 'logs') {
      const st = await loadState(db);
      const logs = st.sigs.filter((s: any) => s.toNum === 'system')
        .sort((x: any, y: any) => x.created < y.created ? -1 : 1)
        .map((s: any) => ({ at: s.created, type: s.type, msg: s.payload, from: s.fromNum }));
      return json({ logs });
    }


    /* ---------- ring lane parity: presence ---------- */
    if (a === 'pres') {
      const node = String(b.node || '');
      if (!node) return json({ err: 'node required' }, 400);
      const st = await loadState(db);
      if (isBanned(st, node)) return json({ err: 'banned' }, 403);
      touchSeen(node);
      return json({ pres: presOf(st, node), ok: true });
    }

    /* ---------- STT: ElevenLabs Scribe, key stays server-side ---------- */
    /* ---------- v176 (skylar, "she sees your screen"): SCREEN VISION ----------
       The live agent captures what is on the user's screen and describes it.
       Vision runs on the same Workers AI stack as KYC — zero naira. */
    if (a === 'visionscreen') {
      const from = String(b.from || ''), aid = String(b.aid || '');
      let q = sanitize(String(b.q || ''), 300);
      if (!q) q = 'Describe what is on this screen clearly and briefly.';
      const img64 = String(b.img || '');
      if (!img64.startsWith('data:image/')) return json({ err: 'bad image' }, 400);
      if (img64.length > 1400000) return json({ err: 'image too large' }, 400);
      const st = await loadState(db);
      if (isBanned(st, from)) return json({ err: 'banned' }, 403);
      const me: any = st.nodes.find((n: any) => n.number === from);
      if (!me) return json({ err: 'unknown' }, 404);
      if (aid && me.aid && String(aid) !== String(me.aid)) return json({ err: 'bad air id' }, 403);
      const day = new Date().toISOString().slice(0, 10);
      const ck = 'vis:' + from + ':' + day;
      const cntRow: any = await getByKey(db, 'AirConnectSettings', ck);
      const cnt = cntRow ? Number(JSON.parse(cntRow.v).n || 0) : 0;
      if (cnt >= 300) return json({ err: 'screen vision daily limit reached — back tomorrow' }, 429); /* v171 spirit: throttle, never ban */
      if (cntRow) await db.entities.AirConnectSettings.update(cntRow.id, { k: ck, v: JSON.stringify({ n: cnt + 1 }) });
      else await db.entities.AirConnectSettings.create({ k: ck, v: JSON.stringify({ n: cnt + 1 }) });
      const comma = img64.indexOf(',');
      let bin: Uint8Array;
      try { bin = Uint8Array.from(atob(img64.slice(comma + 1)), (ch: string) => ch.charCodeAt(0)); } catch (e: any) { return json({ err: 'bad image data' }, 400); }
      const img = [...bin];
      const sysQ = 'You are the AirConnect live agent looking at the user\'s screen. ' + q + ' Answer clearly and briefly, at most 3 short sentences.';
      let out = '';
      try { const r: any = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', { image: img, prompt: sysQ, max_tokens: 220 }); out = String((r && (r.response || r.description || r.short_answer)) || '').trim(); } catch (e: any) {}
      if (!out) return json({ err: 'vision unavailable — try again shortly' }, 503);
      return json({ ok: true, desc: out });
    }

    if (a === 'stt') {
      let audio = String(b.audio || '');
      if (!audio.startsWith('data:audio/')) return json({ err: 'bad audio' }, 400);
      if (audio.length > 1600000) return json({ err: 'chunk too large' }, 400);
      const comma = audio.indexOf(',');
      const head = audio.slice(5, comma);
      const mime = (head.split(';')[0] || 'audio/webm');
      const bytes = Uint8Array.from(atob(audio.slice(comma + 1)), (c) => c.charCodeAt(0));
      const ext = mime.includes('mp4') ? 'mp4' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : 'webm';
      const fd = new FormData();
      fd.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), 'chunk.' + ext);
      fd.append('model_id', 'scribe_v1');
      fd.append('diarize', 'false');
      const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST', headers: { 'xi-api-key': XI_KEY }, body: fd,
      });
      const txt = await r.text();
      let out: any = {};
      try { out = JSON.parse(txt); } catch { out = { err: 'bad upstream: ' + txt.slice(0, 120) }; }
      if (!r.ok) return json({ err: 'stt upstream ' + r.status, detail: String(out.detail || out.message || '').slice(0, 120) }, 502);
      const transcript = String(out.text ?? out.transcription ?? '');
      return json({ ok: true, text: transcript.slice(0, 500), lang: out.language_code || '' });
    }

    /* ---------- premium Guardian voice (Brian) ---------- */
    if (a === 'xtts') {
      const text = String(b.text || '').slice(0, 900).trim();
      if (!text) return json({ err: 'text required' }, 400);
      const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + XI_VOICE_ID, {
        method: 'POST',
        headers: { 'xi-api-key': XI_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
      });
      if (!r.ok) {
        const errText = await r.text();
        return json({ err: 'tts upstream ' + r.status, detail: errText.slice(0, 200) }, 502);
      }
      const bytes = await r.arrayBuffer();
      return new Response(bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
    }

    /* ---------- greetings ---------- */
    if (a === 'greet') {
      const op = String(b.op || '');
      const num = String(b.num || '').trim();
      if (!/^\d{9,12}$/.test(num)) return json({ err: 'bad number' }, 400);
      if (op === 'set') {
        const text = sanitize(b.text, 500);
        if (text.length < 5) return json({ err: 'greeting text too short' }, 400);
        const rec: any = await getByKey(db, 'AirConnectSettings', 'greet:' + num); /* v62 targeted */
        if (rec) await updateRec(db, 'AirConnectSettings', rec.id, { v: text });
        else await db.entities.AirConnectSettings.create({ k: 'greet:' + num, v: text });
        return json({ ok: true });
      }
      if (op === 'get') {
        const rec: any = await getByKey(db, 'AirConnectSettings', 'greet:' + num); /* v62 targeted */
        return json({ ok: true, text: (rec && rec.v) || '' });
      }
      return json({ err: 'unknown op' }, 400);
    }

    /* ---------- AIR ID: owner login (email + password) ---------- */
    if (a === 'adminlogin') {
      const em = String(b.email || '').trim().toLowerCase();
      const pw = String(b.pass || '');
      if (!em || !pw) return json({ err: 'email and pass required' }, 400);
      const hash = await sha256hex(em + '|' + pw);
      if (em === String(env.ADMIN_EMAIL || '').trim().toLowerCase() && hash === String(env.ADMIN_HASH || ''))
        return json({ ok: true, tk: String(env.ADMIN_TK || '') });
      return json({ err: 'forbidden' }, 403);
    }

    /* ---------- admin: unban (token-gated) ---------- */
    if (a === 'otpdump') { /* v83: owner tool — fresh signup codes for instant relay to Samuel */
      if (String(b.tk || '') !== String(env.ADMIN_TK || '')) return json({ err: 'forbidden' }, 403);
      const st = await loadState(db);
      const nowT = Date.now();
      const fresh: any[] = [];
      for (const kk of Object.keys(st.otps || {})) {
        const o: any = (st.otps as any)[kk] || {};
        if (nowT - Number(o.at || 0) < 600000) fresh.push({ key: kk, code: o.code, at: o.at });
      }
      fresh.sort((x: any, y: any) => y.at - x.at);
      return json({ ok: true, fresh });
    }
    /* ---------- v171 (skylar directive): banned users are TOLD, verify humanity, restored within 5h ----------
       A ban now comes with a visible reason and a path back: 5 simple human-verification
       questions; pass 4 of 5 and the cron restores the account within a minute (never past 5 hours). */
    const APPEAL_POOL: any[] = [
      { q: 'What is 7 + 5?', a: '12' }, { q: 'Which number is bigger: 9 or 3?', a: '9' },
      { q: 'How many legs does a dog have?', a: '4' }, { q: 'Type the word WATER', a: 'water' },
      { q: 'What color is a ripe banana?', a: 'yellow' }, { q: 'What is 10 minus 4?', a: '6' },
      { q: 'How many days are in one week?', a: '7' }, { q: 'Type the word HELLO', a: 'hello' },
      { q: 'What is 3 + 3?', a: '6' }, { q: 'How many hours are in one day?', a: '24' },
      { q: 'Which number is bigger: 2 or 8?', a: '8' }, { q: 'What do you call frozen water?', a: 'ice' }
    ];
    if (a === 'appealstart') {
      const num = String(b.num || '').replace(/[^0-9]/g, '');
      if (!num) return json({ err: 'num required' }, 400);
      const st = await loadState(db);
      const ban: any = (st.bans || []).find((x: any) => x.num === num);
      if (!ban) return json({ err: 'not banned' }, 400);
      let ap: any = (st.appeals || {})[num];
      if (ap && ap.passed) return json({ ok: true, passed: 1, note: 'Verification passed — your account is being restored. It is guaranteed back within 5 hours.' });
      if (!ap || Date.now() - (ap.at || 0) > 30 * 60 * 1000) {
        const pick = [...APPEAL_POOL].sort(() => Math.random() - 0.5).slice(0, 5);
        ap = { at: Date.now(), qs: pick.map((x: any) => x.q), ans: pick.map((x: any) => x.a), tries: ap ? ap.tries : 0 };
        (st.appeals = st.appeals || {})[num] = ap;
        trimState(st); await saveState(db, st);
      }
      return json({ ok: true, banned: 1, reason: String(ban.reason || ''), questions: ap.qs, tries: ap.tries || 0 });
    }
    if (a === 'appealanswer') {
      const num = String(b.num || '').replace(/[^0-9]/g, '');
      const answers = Array.isArray(b.answers) ? b.answers.map((x: any) => String(x || '').toLowerCase().trim()).slice(0, 5) : [];
      const st = await loadState(db);
      const ap: any = (st.appeals || {})[num];
      if (!ap) return json({ err: 'start verification first' }, 400);
      if (ap.passed) return json({ ok: true, passed: 1 });
      if (ap.lockUntil && Date.now() < ap.lockUntil) return json({ err: 'too many attempts — try again in an hour' }, 429);
      let score = 0;
      for (let i = 0; i < ap.ans.length; i++) if (answers[i] === String(ap.ans[i]).toLowerCase().trim()) score++;
      if (score >= 4) {
        ap.passed = Date.now(); ap.ans = []; ap.qs = [];
        trimState(st); await saveState(db, st);
        return json({ ok: true, passed: 1, score, note: 'Verification passed — your account will be restored within 5 hours (usually within a minute). You may need to re-add friends.' });
      }
      ap.tries = (ap.tries || 0) + 1;
      if (ap.tries >= 3) { ap.lockUntil = Date.now() + 3600 * 1000; ap.tries = 0; }
      trimState(st); await saveState(db, st);
      return json({ ok: false, score, need: 4, note: 'Not quite — read the questions and try again.' });
    }
    if (a === 'unban') {
      if (String(b.tk || '') !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      const num = String(b.num || '').replace(/[^0-9]/g, '');
      if (!num) return json({ err: 'num required' }, 400);
      const st = await loadState(db);
      st.bans = (st.bans || []).filter((x: any) => x.num !== num);
      await saveState(db, st);
      return json({ ok: true, bans: st.bans });
    }

    /* ---------- v47 admin: account-merge alias + ghost purge ---------- */
    if (a === 'alias') {
      if (String(b.tk || '') !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      const num = String(b.num || '').replace(/[^0-9]/g, '');
      const target = String(b.target || '').replace(/[^0-9]/g, '');
      if (!num || !target) return json({ err: 'num/target required' }, 400);
      await kvPut(db, 'alias:' + num, target);
      return json({ ok: true, alias: num, target });
    }
    if (a === 'purge') {
      if (String(b.tk || '') !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      const nums = (Array.isArray(b.nums) ? b.nums : String(b.nums || '').split(',')).map((x: any) => String(x).replace(/[^0-9]/g, '')).filter(Boolean);
      if (!nums.length) return json({ err: 'nums required' }, 400);
      let purged = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        for (const num of nums) {
          if (num === '234100000001') continue; // the owner's account is untouchable
          if (st.nodes.some((n: any) => n.number === num)) { banUser(st, num, 'purged ghost'); purged++; }
        }
        st.bans = st.bans.filter((x: any) => !nums.includes(String(x.num))); // gone, not banned
        await saveState(db, st);
        const chk = await loadState(db);
        if (!nums.some((num: any) => chk.nodes.some((n: any) => n.number === num) && num !== '234100000001'))
          return json({ ok: true, purged, banned: chk.bans });
      }
      return json({ err: 'conflict, retry' }, 503);
    }

    /* ---------- one-shot migration from Base44 (token-gated) ---------- */
    if (a === 'migrate') {
      if (String(b.tk || '') !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      let ns = 0, nm = 0;
      for (const r of (b.settings || [])) {
        await db.entities.AirConnectSettings.create({ k: String(r.k || ''), v: String(r.v || ''), created_date: r.created_date });
        ns++;
      }
      for (const r of (b.messages || [])) {
        await db.entities.AirConnectMessage.create({ fromNum: String(r.fromNum || ''), toNum: String(r.toNum || ''), text: String(r.text || ''), created_date: r.created_date });
        nm++;
      }
      bumpCache();
      return json({ ok: true, settings: ns, messages: nm });
    }

    /* ---------- admin: create friend edge directly (owner <-> citizen fleet) ---------- */
    /* ---------- v42.2: admin rename nodes ---------- */
    if (a === 'adminrename') {
      if (String(b.tk || '') !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      const nodes = Array.isArray(b.nodes) ? b.nodes : [];
      let made = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        for (const nd of nodes) {
          const num = String((nd || {}).num || '').replace(/[^0-9]/g, '');
          const name = sanitize(String((nd || {}).name || ''), 32);
          const me = st.nodes.find((n: any) => n.number === num);
          if (me && name) { me.name = name; made++; }
        }
        await saveState(db, st);
        const chk = await loadState(db);
        let okAll = true;
        for (const nd of nodes) {
          const me = chk.nodes.find((n: any) => n.number === String((nd || {}).num || ''));
          if (me && me.name !== sanitize(String((nd || {}).name || ''), 32)) okAll = false;
        }
        if (okAll) return json({ ok: true, made });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    /* ---------- v42: admin batch node creation (poster fleet / citizens) ---------- */
    if (a === 'adminnodes') {
      if (String(b.tk || '') !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      const nodes = Array.isArray(b.nodes) ? b.nodes : [];
      if (!nodes.length) return json({ err: 'nodes required' }, 400);
      let made = 0, skipped = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        for (const nd of nodes) {
          const num = String((nd || {}).num || '').replace(/[^0-9]/g, '');
          const name = sanitize(String((nd || {}).name || ''), 32);
          const aid = String((nd || {}).aid || '').slice(0, 64);
          if (!/^\d{9,12}$/.test(num) || !name) { skipped++; continue; }
          if (st.nodes.find((n: any) => n.number === num)) { skipped++; continue; }
          st.nodes.push({ name, number: num, status: 'active', created: new Date().toISOString(), aid, country: 'NG' });
          made++;
        }
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        let okAll = true;
        for (const nd of nodes) {
          const num = String((nd || {}).num || '');
          if (/^\d{9,12}$/.test(num) && !chk.nodes.find((n: any) => n.number === num)) okAll = false;
        }
        if (okAll) return json({ ok: true, made, skipped });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    if (a === 'adminfriends') {
      if (String(b.tk || '') !== String(env.ADMIN_TK || 'air-unban-2026')) return json({ err: 'forbidden' }, 403);
      const pairs = Array.isArray(b.pairs) ? b.pairs : [];
      let made = 0, skipped = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await loadState(db);
        for (const pr of pairs) {
          const a1 = String((pr || [])[0] || '').replace(/[^0-9]/g, '');
          const b1 = String((pr || [])[1] || '').replace(/[^0-9]/g, '');
          if (!a1 || !b1 || a1 === b1) { skipped++; continue; }
          if (!st.nodes.find((n: any) => n.number === a1) || !st.nodes.find((n: any) => n.number === b1)) { skipped++; continue; }
          const pair = [a1, b1].sort();
          if (!st.friends.some((f: any) => f.a === pair[0] && f.b === pair[1])) {
            st.friends.push({ a: pair[0], b: pair[1] });
            made++;
          }
        }
        trimState(st);
        await saveState(db, st);
        const chk = await loadState(db);
        let allThere = true;
        for (const pr of pairs) {
          const a1 = String((pr || [])[0] || '').replace(/[^0-9]/g, '');
          const b1 = String((pr || [])[1] || '').replace(/[^0-9]/g, '');
          if (!a1 || !b1) continue;
          const pair = [a1, b1].sort();
          if (!chk.friends.some((f: any) => f.a === pair[0] && f.b === pair[1])) allThere = false;
        }
        if (allThere) return json({ ok: true, made, skipped, total: chk.friends.length });
      }
      return json({ err: 'conflict, try again' }, 503);
    }

    return json({ err: 'unknown act: ' + String(a) }, 400);
  } catch (e) {
    return json({ err: 'trunk error: ' + String(e && (e as any).message ? (e as any).message : e).slice(0, 200) }, 500);
  }
  },
};
