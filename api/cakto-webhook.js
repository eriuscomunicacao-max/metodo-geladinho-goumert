/**
 * Webhook da Cakto -> API de Conversões da Meta (evento Purchase).
 *
 * Variáveis de ambiente (configure na Vercel, NUNCA no código):
 *   CAKTO_WEBHOOK_SECRET   chave secreta do webhook cadastrado na Cakto
 *   META_PIXEL_ID          ID do pixel (938527535303791)
 *   META_ACCESS_TOKEN      token da API de Conversões (Gerenciador de Eventos)
 *   META_TEST_EVENT_CODE   (opcional) código da aba "Testar eventos"; remova ao ir para produção
 *   META_GRAPH_VERSION     (opcional) padrão v23.0; atualize se a Meta recusar a versão
 *   SITE_URL               (opcional) padrão https://metodo-geladinho-goumert.vercel.app/
 */
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const clean = (s) => (s == null ? '' : String(s).trim().toLowerCase());

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 || d.length === 11) d = '55' + d; // celular/fixo BR sem DDI
  return d;
}

// A página manda fbp/fbc/UA dentro do parâmetro sck: "fbp:...|fbc:...|ua:..."
function fromSck(sck) {
  const out = {};
  if (!sck) return out;
  String(sck).split('|').forEach((part) => {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  });
  return out;
}

function buildEvent(d) {
  const c = d.customer || {};
  const t = fromSck(d.sck);
  const fbp = d.fbp || t.fbp || undefined;
  const fbc = d.fbc || t.fbc || undefined;
  const ua = t.ua || undefined;

  const name = clean(c.name).split(/\s+/).filter(Boolean);
  const user = {};
  const em = clean(c.email);
  const ph = normPhone(c.phone);
  if (em) { user.em = [sha(em)]; user.external_id = [sha(em)]; }
  if (ph) user.ph = [sha(ph)];
  if (name[0]) user.fn = [sha(name[0])];
  if (name.length > 1) user.ln = [sha(name[name.length - 1])];
  user.country = [sha('br')];
  if (fbp) user.fbp = fbp;
  if (fbc) user.fbc = fbc;
  if (ua) user.client_user_agent = ua;

  const when = Date.parse(d.paidAt || d.createdAt || '') || Date.now();
  return {
    event_name: 'Purchase',
    event_time: Math.floor(when / 1000),
    event_id: String(d.id || d.refId),   // mesma venda reenviada = deduplicada pela Meta
    // A Meta exige client_user_agent em eventos "website". Sem ele, marcamos como "other".
    action_source: ua ? 'website' : 'other',
    event_source_url: process.env.SITE_URL || 'https://metodo-geladinho-goumert.vercel.app/',
    user_data: user,
    custom_data: {
      value: Number(d.amount),
      currency: 'BRL',
      order_id: String(d.refId || d.id),
      content_name: (d.product && d.product.name) || 'Metodo Geladinho Lucrativo',
      content_type: 'product',
      content_ids: [String((d.product && (d.product.short_id || d.product.id)) || 'geladinho')],
      num_items: 1,
      utm_source: d.utm_source || undefined,
      utm_campaign: d.utm_campaign || undefined,
      utm_content: d.utm_content || undefined,
    },
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'invalid body' });

  const secret = process.env.CAKTO_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: 'server not configured' });
  if (!safeEqual(body.secret, secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  // Só vendas pagas interessam. Os outros eventos recebem 200 para a Cakto não reenviar.
  const d = body.data || {};
  if (body.event !== 'purchase_approved' || (d.status && d.status !== 'paid')) {
    return res.status(200).json({ ok: true, ignored: body.event || 'unknown' });
  }
  if (!(Number(d.amount) > 0) || !(d.id || d.refId)) {
    return res.status(200).json({ ok: true, ignored: 'no amount or id' });
  }

  const pixel = process.env.META_PIXEL_ID, token = process.env.META_ACCESS_TOKEN;
  if (!pixel || !token) return res.status(500).json({ ok: false, error: 'meta not configured' });

  const evt = buildEvent(d);
  const payload = { data: [evt] };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  const ver = process.env.META_GRAPH_VERSION || 'v23.0';
  try {
    const r = await fetch('https://graph.facebook.com/' + ver + '/' + pixel + '/events?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Meta CAPI erro', r.status, JSON.stringify(j.error || j)); // sem dados pessoais
      return res.status(502).json({ ok: false, error: 'meta rejected', code: j.error && j.error.code });
    }
    console.log('Purchase enviado', evt.event_id, 'src=' + evt.action_source, 'recebidos=' + j.events_received);
    return res.status(200).json({ ok: true, events_received: j.events_received });
  } catch (e) {
    console.error('Falha ao chamar a Meta', e && e.message);
    return res.status(502).json({ ok: false, error: 'meta unreachable' });
  }
};
