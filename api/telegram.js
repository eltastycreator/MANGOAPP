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

async function parseGasto(texto) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Extraé los datos de este gasto y respondé SOLO con JSON válido, sin texto extra, sin markdown:
{"desc":"descripción corta","monto":1234.56,"cat":"Categoría","pago":"Efectivo"}

Categorías posibles: Comida, Transporte, Entretenimiento, Salud, Ropa, Hogar, Educación, Otros
Formas de pago posibles: Efectivo, Débito, Crédito, Transferencia (si no se menciona, usar Efectivo)

Mensaje del usuario: "${texto}"`
      }]
    })
  });
  const data = await res.json();
  const raw = data.content?.[0]?.text?.trim();
  return JSON.parse(raw);
}

async function addGasto(user_id, gasto) {
  // Traer data actual del usuario
  const rows = await supabase('GET', `/rest/v1/user_data?user_id=eq.${user_id}&select=data`);
  if (!rows || rows.length === 0) return false;

  const userData = rows[0].data || {};
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

  await supabase('PATCH', `/rest/v1/user_data?user_id=eq.${user_id}`, {
    data: userData,
    updated_at: new Date().toISOString()
  });
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
      await sendMessage(chat_id, '📖 *Cómo cargar un gasto:*\n\nMandame un mensaje describiendo el gasto:\n\n• _"almuerzo 1500"_\n• _"taxi 800 transporte"_\n• _"supermercado 12500 crédito"_\n\nYo me encargo del resto 🤖');
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
