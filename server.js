const express = require('express'), crypto = require('crypto'), path = require('path');
const { createClient } = require('@supabase/supabase-js');
const E = process.env;
const GID = E.GOOGLE_CLIENT_ID || '372392007476-53d1cll8jk0jpj0bvrkv5bouc4rnn54c.apps.googleusercontent.com';
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SECRET_KEY);
const SEC = E.SESSION_SECRET || E.ADMIN_PASSWORD || 'troque-isto';
const app = express();
app.use(express.json());
const file = f => (q, r) => r.sendFile(path.join(__dirname, f));
app.get('/', file('index.html'));
app.get('/admin', file('admin.html'));

const hm = b => crypto.createHmac('sha256', SEC).update(b).digest('base64url');
const sign = o => { const b = Buffer.from(JSON.stringify({ ...o, exp: Date.now() + 2592e6 })).toString('base64url'); return b + '.' + hm(b); };
const verify = t => { try { const [b, s] = t.split('.'); if (s !== hm(b)) return null; const o = JSON.parse(Buffer.from(b, 'base64url')); return o.exp > Date.now() ? o : null; } catch { return null; } };
const auth = (q, r, n) => { const u = verify((q.headers.authorization || '').slice(7)); if (!u) return r.status(401).json({ error: 'Faça login com o Google' }); q.user = u; n(); };
const sha = s => crypto.createHash('sha256').update(s).digest();
const adm = (q, r, n) => { if (!E.ADMIN_PASSWORD || !crypto.timingSafeEqual(sha(q.headers['x-admin'] || ''), sha(E.ADMIN_PASSWORD))) return r.status(401).json({ error: 'Senha inválida' }); n(); };
const getSet = async () => { const { data } = await sb.from('settings').select('*'); return Object.fromEntries((data || []).map(x => [x.k, x.v])); };
const stockMap = async () => { const { data } = await sb.from('keys').select('plan_id').eq('used', false).limit(100000); const c = {}; (data || []).forEach(k => c[k.plan_id] = (c[k.plan_id] || 0) + 1); return c; };

app.get('/api/store', async (q, r) => {
  const s = await getSet(), c = await stockMap();
  const { data: pl } = await sb.from('plans').select('*').order('price');
  r.json({ gid: GID, name: s.name, desc: s.desc, image: s.image, whatsapp: s.whatsapp, soldout: s.soldout === 'true', plans: (pl || []).map(p => ({ ...p, stock: c[p.id] || 0 })) });
});

app.post('/api/login', async (q, r) => {
  try {
    const j = await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(q.body.credential))).json();
    if (j.aud !== GID || !j.email) throw 0;
    const u = { email: j.email, name: j.name, pic: j.picture };
    r.json({ token: sign(u), user: u });
  } catch { r.status(401).json({ error: 'Login inválido' }); }
});

app.post('/api/buy', auth, async (q, r) => {
  const s = await getSet();
  if (s.soldout === 'true') return r.status(400).json({ error: 'Produto esgotado, em atualização' });
  if (!E.MP_ACCESS_TOKEN) return r.status(503).json({ error: 'Pagamento ainda não configurado' });
  const { data: p } = await sb.from('plans').select('*').eq('id', q.body.plan_id).single();
  if (!p) return r.status(404).json({ error: 'Plano não encontrado' });
  const { count } = await sb.from('keys').select('id', { count: 'exact', head: true }).eq('plan_id', p.id).eq('used', false);
  if (!count) return r.status(400).json({ error: 'Sem estoque neste plano' });
  const id = crypto.randomUUID();
  const m = await (await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + E.MP_ACCESS_TOKEN, 'Content-Type': 'application/json', 'X-Idempotency-Key': id },
    body: JSON.stringify({ transaction_amount: Number(p.price), description: (s.name || 'CYBER MENU') + ' - ' + p.name, payment_method_id: 'pix', payer: { email: q.user.email }, external_reference: id })
  })).json();
  const t = m.point_of_interaction && m.point_of_interaction.transaction_data;
  if (!t) return r.status(502).json({ error: 'Não foi possível gerar o PIX', detail: m.message });
  await sb.from('orders').insert({ id, email: q.user.email, plan_id: p.id, plan_name: p.name, amount: p.price, mp_id: String(m.id), status: 'pending' });
  r.json({ id, qr: t.qr_code, qr64: t.qr_code_base64, amount: p.price });
});

const busy = new Set();
async function check(o) {
  if (busy.has(o.id)) return o;
  busy.add(o.id);
  try {
    if (o.status === 'pending') {
      const m = await (await fetch('https://api.mercadopago.com/v1/payments/' + o.mp_id, { headers: { Authorization: 'Bearer ' + E.MP_ACCESS_TOKEN } })).json();
      if (m.status === 'approved') { await sb.from('orders').update({ status: 'paid' }).eq('id', o.id); o.status = 'paid'; }
      else if (['cancelled', 'rejected', 'expired'].includes(m.status)) { await sb.from('orders').update({ status: 'failed' }).eq('id', o.id); o.status = 'failed'; }
    }
    if (o.status === 'paid' && !o.key) {
      for (let i = 0; i < 5 && !o.key; i++) {
        const { data: k } = await sb.from('keys').select('id,key').eq('plan_id', o.plan_id).eq('used', false).limit(1);
        if (!k || !k.length) break;
        const { data: u } = await sb.from('keys').update({ used: true, order_id: o.id }).eq('id', k[0].id).eq('used', false).select();
        if (u && u.length) { o.key = u[0].key; await sb.from('orders').update({ key: o.key }).eq('id', o.id); }
      }
    }
  } finally { busy.delete(o.id); }
  return o;
}
const pub = (o, s) => ({ id: o.id, status: o.status, plan: o.plan_name, key: o.key, apk: o.key ? s.apk : null, date: o.created_at });

app.get('/api/order/:id', auth, async (q, r) => {
  const { data: o } = await sb.from('orders').select('*').eq('id', q.params.id).eq('email', q.user.email).single();
  if (!o) return r.sendStatus(404);
  r.json(pub(await check(o), await getSet()));
});
app.get('/api/orders', auth, async (q, r) => {
  const { data } = await sb.from('orders').select('*').eq('email', q.user.email).order('created_at', { ascending: false }).limit(30);
  const s = await getSet(), out = [];
  for (const o of data || []) {
    if (E.MP_ACCESS_TOKEN && (o.status === 'pending' || (o.status === 'paid' && !o.key))) { try { await check(o); } catch {} }
    out.push(pub(o, s));
  }
  r.json(out);
});

/* ---- ADMIN ---- */
app.get('/api/admin/data', adm, async (q, r) => {
  const s = await getSet(), c = await stockMap();
  const { data: pl } = await sb.from('plans').select('*').order('price');
  const { data: od } = await sb.from('orders').select('email,plan_name,amount,status,created_at').order('created_at', { ascending: false }).limit(30);
  r.json({ s, plans: (pl || []).map(p => ({ ...p, stock: c[p.id] || 0 })), orders: od || [] });
});
app.post('/api/admin/settings', adm, async (q, r) => {
  const ok = ['name', 'desc', 'image', 'whatsapp', 'apk', 'soldout'];
  const rows = Object.entries(q.body).filter(([k]) => ok.includes(k)).map(([k, v]) => ({ k, v: String(v) }));
  const x = await sb.from('settings').upsert(rows, { onConflict: 'k' });
  if (x.error) { console.error('settings:', x.error); return r.status(500).json({ error: 'Banco: ' + x.error.message }); }
  r.json({ ok: true });
});
app.post('/api/admin/plan', adm, async (q, r) => {
  const { id, name, price } = q.body, row = { name, price: Number(price) };
  if (!name || !String(name).trim() || !(row.price >= 0) || isNaN(row.price)) return r.status(400).json({ error: 'Preencha o nome e o preço do plano' });
  const x = id ? await sb.from('plans').update(row).eq('id', id) : await sb.from('plans').insert(row);
  if (x.error) { console.error('plan:', x.error); return r.status(500).json({ error: 'Banco: ' + x.error.message }); }
  r.json({ ok: true });
});
app.delete('/api/admin/plan/:id', adm, async (q, r) => {
  const a = await sb.from('keys').delete().eq('plan_id', q.params.id).eq('used', false);
  if (a.error) return r.status(500).json({ error: 'Banco: ' + a.error.message });
  const b = await sb.from('plans').delete().eq('id', q.params.id);
  if (b.error) return r.status(500).json({ error: 'Banco: ' + b.error.message });
  r.json({ ok: true });
});
app.post('/api/admin/keys', adm, async (q, r) => {
  const ks = [...new Set(String(q.body.keys).split('\n').map(x => x.trim()).filter(Boolean))].map(key => ({ plan_id: q.body.plan_id, key }));
  if (!ks.length) return r.json({ ok: false, error: 'Nenhuma key' });
  const x = await sb.from('keys').insert(ks);
  if (x.error) { console.error('keys:', x.error); return r.status(500).json({ error: 'Banco: ' + x.error.message }); }
  r.json({ ok: true, added: ks.length });
});

app.listen(E.PORT || 3000, () => console.log('CYBER ONLINE no ar'));
