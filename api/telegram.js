const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function sendMessage(chat_id, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'Markdown' })
  });
}

async function supabase(method, path, body) {
  const res = await fetch(`https://arimnsdiwwgkvfwmoevw.supabase.co${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': method === 'POST' ? 'return=representation' : ''
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function getLinkedUser(chat_id) {
  const data = await supabase('GET', `/rest/v1/telegram_users?chat_id=eq.${chat_id}&select=*`);
  return data?.[0] || null;
}

async function linkUser(chat_id, email) {
  // Buscar el user por email en user_data
  const users = await supabase('GET', `/rest/v1/user_data?email=eq.${email}&select=user_id,email`);
  if (!users || users.length === 0) return null;
  const user = users[0];

  // Vincular chat_id con user_id
  await supabase('POST', `/rest/v1/telegram_users`, {
    chat_id: String(chat_id),
    user_id: user.user_id,
    email: user.email
  });
  return user;
}

function parseGasto(texto) {
  const partes = texto.trim().split(/\s+/);

  // Categorías reconocibles
  const CATS = ['comida','transporte','entretenimiento','salud','ropa','hogar','educacion','educación','otros'];
  const PAGOS = ['efectivo','débito','debito','crédito','credito','transferencia'];
  const PAGOS_MAP = { 'debito':'Débito','débito':'Débito','credito':'Crédito','crédito':'Crédito','transferencia':'Transferencia','efectivo':'Efectivo' };
  const CATS_MAP = { 'comida':'Comida','transporte':'Transporte','entretenimiento':'Entretenimiento','salud':'Salud','ropa':'Ropa','hogar':'Hogar','educacion':'Educación','educación':'Educación','otros':'Otros' };

  let desc = [];
  let monto = null;
  let cat = 'Otros';
  let pago = 'Efectivo';

  for (const p of partes) {
    const lower = p.toLowerCase();
    if (!monto && /^[0-9]+([.,][0-9]+)?$/.test(p)) {
      monto = parseFloat(p.replace(',', '.'));
    } else if (CATS.includes(lower)) {
      cat = CATS_MAP[lower];
    } else if (PAGOS.includes(lower)) {
      pago = PAGOS_MAP[lower];
    } else {
      desc.push(p);
    }
  }

  return {
    desc: desc.join(' ') || 'Gasto',
    monto: monto || 0,
    cat,
    pago
  };
}

async function addGasto(user_id, gasto) {
  // Traer data actual del usuario
  const rows = await supabase('GET', `/rest/v1/user_data?user_id=eq.${user_id}&select=data`);
  if (!rows || rows.length === 0) return false;

  let raw = rows[0].data || '{}';
  let userData = {};
  try {
    userData = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // A veces viene doble-escapado
    if (typeof userData === 'string') userData = JSON.parse(userData);
  } catch(e) {
    userData = {};
  }
  if (!userData.gastos) userData.gastos = [];

  const today = new Date().toISOString().split('T')[0];
  userData.gastos.push({
    id: Date.now(),
    desc: gasto.desc,
    monto: gasto.monto,
    cat: gasto.cat,
    pago: gasto.pago || 'Efectivo',
    fecha: today
  });

  const result = await supabase('PATCH', `/rest/v1/user_data?user_id=eq.${user_id}`, {
    data: JSON.stringify(userData),
    updated_at: new Date().toISOString()
  });
  if (result?.code) { console.error('PATCH error:', JSON.stringify(result)); return false; }
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const { message } = req.body;
  if (!message) return res.status(200).json({ ok: true });

  const chat_id = message.chat.id;
  const texto = message.text?.trim();
  if (!texto) return res.status(200).json({ ok: true });

  try {
    // Comando /start o /vincular
    if (texto.startsWith('/start') || texto.startsWith('/vincular')) {
      await sendMessage(chat_id, '👋 Hola! Soy el bot de *Mango*.\n\nPara vincular tu cuenta mandame tu email:\n`/email tucorreo@gmail.com`');
      return res.status(200).json({ ok: true });
    }

    // Comando /email para vincular cuenta
    if (texto.startsWith('/email')) {
      const email = texto.split(' ')[1]?.toLowerCase().trim();
      if (!email) {
        await sendMessage(chat_id, '⚠️ Formato: `/email tucorreo@gmail.com`');
        return res.status(200).json({ ok: true });
      }
      const user = await linkUser(chat_id, email);
      if (!user) {
        await sendMessage(chat_id, '❌ No encontré ninguna cuenta con ese email. Verificá que sea el mismo con el que te registraste en Mango.');
      } else {
        await sendMessage(chat_id, `✅ Cuenta vinculada! Hola *${email}* 🎉\n\nAhora podés cargar gastos así:\n_"almuerzo 1500"_\n_"taxi 800 transporte débito"_`);
      }
      return res.status(200).json({ ok: true });
    }

    // Comando /ayuda
    if (texto.startsWith('/ayuda') || texto.startsWith('/help')) {
      await sendMessage(chat_id, '📖 *Cómo cargar un gasto:*\n\nMandame el gasto en este formato:\n`descripción monto categoría formadepago`\n\n*Ejemplos:*\n• `almuerzo 1500`\n• `taxi 800 transporte`\n• `supermercado 12500 comida crédito`\n\n*Categorías:* Comida, Transporte, Entretenimiento, Salud, Ropa, Hogar, Educación, Otros\n*Pagos:* Efectivo, Débito, Crédito, Transferencia\n\nSi no ponés categoría o pago, uso *Otros* y *Efectivo* por defecto.');
      return res.status(200).json({ ok: true });
    }

    // Verificar si el usuario está vinculado
    const linked = await getLinkedUser(chat_id);
    if (!linked) {
      await sendMessage(chat_id, '⚠️ Primero tenés que vincular tu cuenta.\n\nMandame: `/email tucorreo@gmail.com`');
      return res.status(200).json({ ok: true });
    }

    // Parsear el gasto con IA
    const gasto = await parseGasto(texto);
    const ok = await addGasto(linked.user_id, gasto);

    if (ok) {
      const fmt = (n) => '$ ' + n.toLocaleString('es-AR');
      await sendMessage(chat_id, `✅ *Gasto cargado!*\n\n📝 ${gasto.desc}\n💰 ${fmt(gasto.monto)}\n🏷️ ${gasto.cat}\n💳 ${gasto.pago}`);
    } else {
      await sendMessage(chat_id, '❌ Hubo un error al guardar el gasto. Intentá de nuevo.');
    }

  } catch (err) {
    console.error(err);
    await sendMessage(chat_id, '❌ No pude entender el gasto. Intentá con algo como: _"almuerzo 1500"_');
  }

  return res.status(200).json({ ok: true });
}
