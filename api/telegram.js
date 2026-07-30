const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_URL = 'https://arimnsdiwwgkvfwmoevw.supabase.co';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function supa(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': method === 'POST' ? 'return=representation' : ''
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!text || text.trim() === '') return null;
  try { return JSON.parse(text); } catch(e) { return null; }
}

async function sendMessage(chat_id, text, reply_markup) {
  const body = { chat_id, text, parse_mode: 'Markdown' };
  if (reply_markup) body.reply_markup = reply_markup;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function editMessage(chat_id, message_id, text, reply_markup) {
  const body = { chat_id, message_id, text, parse_mode: 'Markdown' };
  if (reply_markup) body.reply_markup = reply_markup;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function answerCallback(callback_query_id) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id })
  });
}

function persistentKeyboard() {
  return {
    keyboard: [[{ text: '➕ Nuevo gasto' }]],
    resize_keyboard: true,
    persistent: true
  };
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function getLinkedUser(chat_id) {
  const data = await supa('GET', `/rest/v1/telegram_users?chat_id=eq.${chat_id}&select=*`);
  return data?.[0] || null;
}

async function getUserData(user_id) {
  const rows = await supa('GET', `/rest/v1/user_data?user_id=eq.${user_id}&select=data`);
  if (!rows || rows.length === 0) return null;
  let raw = rows[0].data;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    let parsed = JSON.parse(raw);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed;
  } catch(e) { return {}; }
}

async function saveUserData(user_id, userData) {
  await supa('PATCH', `/rest/v1/user_data?user_id=eq.${user_id}`, {
    data: JSON.stringify(userData),
    updated_at: new Date().toISOString()
  });
}

async function getSession(chat_id) {
  const rows = await supa('GET', `/rest/v1/telegram_sessions?chat_id=eq.${chat_id}&select=*`);
  return rows?.[0] || { chat_id, state: 'idle', data: {} };
}

async function saveSession(chat_id, state, data = {}) {
  const existing = await supa('GET', `/rest/v1/telegram_sessions?chat_id=eq.${chat_id}&select=chat_id`);
  if (existing && existing.length > 0) {
    await supa('PATCH', `/rest/v1/telegram_sessions?chat_id=eq.${chat_id}`, {
      state, data, updated_at: new Date().toISOString()
    });
  } else {
    await supa('POST', `/rest/v1/telegram_sessions`, {
      chat_id: String(chat_id), state, data, updated_at: new Date().toISOString()
    });
  }
}

async function clearSession(chat_id) {
  await saveSession(String(chat_id), 'idle', {});
}

// ── Botones ───────────────────────────────────────────────────────────────────

function tipoButtons() {
  return {
    inline_keyboard: [[
      { text: '📅 Diario', callback_data: 'tipo:diario' },
      { text: '💳 Cuota', callback_data: 'tipo:cuota' },
      { text: '📌 Fijo', callback_data: 'tipo:fijo' }
    ]]
  };
}

function catButtons(cats) {
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [{ text: cats[i].name, callback_data: `cat:${cats[i].name}` }];
    if (cats[i+1]) row.push({ text: cats[i+1].name, callback_data: `cat:${cats[i+1].name}` });
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancelar', callback_data: 'cancel' }]);
  return { inline_keyboard: rows };
}

function pagoButtons() {
  return {
    inline_keyboard: [
      [
        { text: '💵 Efectivo', callback_data: 'pago:Efectivo' },
        { text: '💳 Débito', callback_data: 'pago:Débito' }
      ],
      [
        { text: '💳 Crédito', callback_data: 'pago:Crédito' },
        { text: '📲 Transferencia', callback_data: 'pago:Transferencia' }
      ],
      [{ text: '❌ Cancelar', callback_data: 'cancel' }]
    ]
  };
}

function cuotasButtons() {
  return {
    inline_keyboard: [
      [
        { text: '2', callback_data: 'cuotas:2' },
        { text: '3', callback_data: 'cuotas:3' },
        { text: '4', callback_data: 'cuotas:4' },
        { text: '6', callback_data: 'cuotas:6' }
      ],
      [
        { text: '9', callback_data: 'cuotas:9' },
        { text: '12', callback_data: 'cuotas:12' },
        { text: '18', callback_data: 'cuotas:18' },
        { text: '24', callback_data: 'cuotas:24' }
      ],
      [{ text: '❌ Cancelar', callback_data: 'cancel' }]
    ]
  };
}

// ── Guardar gasto ─────────────────────────────────────────────────────────────

async function guardarGasto(user_id, sessionData) {
  const { tipo, desc, monto, cat, pago, ncuotas } = sessionData;
  const userData = await getUserData(user_id);
  const today = new Date().toISOString().split('T')[0];
  const mesActual = today.slice(0, 7);

  if (tipo === 'diario') {
    if (!userData.gastos) userData.gastos = [];
    userData.gastos.push({
      id: Date.now(), desc, monto: parseFloat(monto), cat, pago, fecha: today
    });
  } else if (tipo === 'fijo') {
    if (!userData.fijos) userData.fijos = [];
    userData.fijos.push({
      id: Date.now(), desc, monto: parseFloat(monto), cat, pago
    });
  } else if (tipo === 'cuota') {
    if (!userData.cuotas) userData.cuotas = [];
    userData.cuotas.push({
      id: Date.now(), desc,
      montoTotal: parseFloat(monto),
      montoCuota: parseFloat((monto / ncuotas).toFixed(2)),
      ncuotas: parseInt(ncuotas),
      pago, mesInicio: mesActual
    });
  }

  await saveUserData(user_id, userData);
}

function fmt(n) {
  return '$ ' + parseFloat(n).toLocaleString('es-AR');
}

function parseMonto(texto) {
  const partes = texto.trim().split(/\s+/);
  let monto = null;
  let descPartes = [];
  for (const p of partes) {
    if (!monto && /^[0-9]+([.,][0-9]+)?$/.test(p)) {
      monto = parseFloat(p.replace(',', '.'));
    } else {
      descPartes.push(p);
    }
  }
  return { desc: descPartes.join(' ') || 'Gasto', monto };
}

// ── Handler principal ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const { message, callback_query } = req.body;

  // ── Callback de botones ──
  if (callback_query) {
    const chat_id = callback_query.message.chat.id;
    const message_id = callback_query.message.message_id;
    const cbData = callback_query.data;
    await answerCallback(callback_query.id);

    if (cbData === 'cancel') {
      await clearSession(String(chat_id));
      await editMessage(chat_id, message_id, '❌ Carga cancelada.');
      return res.status(200).json({ ok: true });
    }

    const linked = await getLinkedUser(String(chat_id));
    if (!linked) {
      await sendMessage(chat_id, '⚠️ Primero vinculá tu cuenta con `/email tucorreo@gmail.com`');
      return res.status(200).json({ ok: true });
    }

    const session = await getSession(String(chat_id));
    const [action, value] = cbData.split(':');

    // Eligió tipo → pedir descripción y monto
    if (action === 'tipo') {
      await saveSession(String(chat_id), 'esperando_desc', { tipo: value });
      const tipoLabel = value === 'diario' ? 'Diario' : value === 'cuota' ? 'Cuota' : 'Fijo';
      await editMessage(chat_id, message_id,
        `📌 Tipo: *${tipoLabel}*\n\nAhora escribí la descripción y el monto:\n_Ej: almuerzo 1500_`
      );
    }

    // Eligió categoría
    else if (action === 'cat') {
      const tipo = session.data.tipo;
      if (tipo === 'cuota') {
        await saveSession(String(chat_id), 'esperando_cuotas', { ...session.data, cat: value });
        await editMessage(chat_id, message_id,
          `📝 *${session.data.desc}* — ${fmt(session.data.monto)}\n🏷️ ${value}\n\n¿En cuántas cuotas?`,
          cuotasButtons()
        );
      } else {
        await saveSession(String(chat_id), 'esperando_pago', { ...session.data, cat: value });
        await editMessage(chat_id, message_id,
          `📝 *${session.data.desc}* — ${fmt(session.data.monto)}\n🏷️ ${value}\n\n¿Forma de pago?`,
          pagoButtons()
        );
      }
    }

    // Eligió cuotas
    else if (action === 'cuotas') {
      await saveSession(String(chat_id), 'esperando_pago', { ...session.data, ncuotas: parseInt(value) });
      await editMessage(chat_id, message_id,
        `📝 *${session.data.desc}* — ${fmt(session.data.monto)}\n🏷️ ${session.data.cat} — ${value} cuotas\n\n¿Forma de pago?`,
        pagoButtons()
      );
    }

    // Eligió pago → guardar
    else if (action === 'pago') {
      const finalData = { ...session.data, pago: value };
      await clearSession(String(chat_id));
      await guardarGasto(linked.user_id, finalData);

      let resumen = `✅ *Gasto cargado!*\n\n`;
      resumen += `📝 ${finalData.desc}\n`;
      resumen += `💰 ${fmt(finalData.monto)}\n`;
      resumen += `🏷️ ${finalData.cat}\n`;
      resumen += `💳 ${value}\n`;
      if (finalData.tipo === 'cuota') {
        resumen += `🔢 ${finalData.ncuotas} cuotas de ${fmt(finalData.monto / finalData.ncuotas)}\n`;
      }
      const tipoLabel = finalData.tipo === 'diario' ? '📅 Diario' : finalData.tipo === 'cuota' ? '💳 Cuota' : '📌 Fijo';
      resumen += tipoLabel;

      await editMessage(chat_id, message_id, resumen);
    }

    return res.status(200).json({ ok: true });
  }

  // ── Mensaje de texto ──
  if (!message) return res.status(200).json({ ok: true });

  const chat_id = message.chat.id;
  const texto = message.text?.trim();
  if (!texto) return res.status(200).json({ ok: true });

  try {
    // /start
    if (texto.startsWith('/start')) {
      const body = {
        chat_id, text: '👋 Hola! Soy el bot de *Mango* 🥭\n\nPara vincular tu cuenta:\n`/email tucorreo@gmail.com`',
        parse_mode: 'Markdown',
        reply_markup: persistentKeyboard()
      };
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      return res.status(200).json({ ok: true });
    }

    // /email
    if (texto.startsWith('/email')) {
      const email = texto.split(' ')[1]?.toLowerCase().trim();
      if (!email) {
        await sendMessage(chat_id, '⚠️ Formato: `/email tucorreo@gmail.com`');
        return res.status(200).json({ ok: true });
      }
      const users = await supa('GET', `/rest/v1/user_data?email=eq.${email}&select=user_id,email`);
      if (!users || users.length === 0) {
        await sendMessage(chat_id, '❌ No encontré ninguna cuenta con ese email.');
        return res.status(200).json({ ok: true });
      }
      const existing = await supa('GET', `/rest/v1/telegram_users?chat_id=eq.${chat_id}&select=chat_id`);
      if (existing && existing.length > 0) {
        await supa('PATCH', `/rest/v1/telegram_users?chat_id=eq.${chat_id}`, { user_id: users[0].user_id, email });
      } else {
        await supa('POST', `/rest/v1/telegram_users`, { chat_id: String(chat_id), user_id: users[0].user_id, email });
      }
      const bodyVinc = {
        chat_id, text: `✅ Cuenta vinculada! Hola *${email}* 🎉\n\nApretá el botón de abajo para cargar tu primer gasto 👇`,
        parse_mode: 'Markdown', reply_markup: persistentKeyboard()
      };
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyVinc)
      });
      return res.status(200).json({ ok: true });
    }

    // /ayuda
    if (texto.startsWith('/ayuda') || texto.startsWith('/help')) {
      await sendMessage(chat_id, '📖 *Cómo cargar un gasto:*\n\nMandame `/nuevo` y seguí los pasos:\n1. Elegís el tipo (Diario, Cuota o Fijo)\n2. Escribís la descripción y monto\n3. Elegís la categoría\n4. Elegís la forma de pago\n\n✅ Listo!');
      return res.status(200).json({ ok: true });
    }

    // Verificar vinculación
    const linked = await getLinkedUser(String(chat_id));
    if (!linked) {
      await sendMessage(chat_id, '⚠️ Primero vinculá tu cuenta con:\n`/email tucorreo@gmail.com`');
      return res.status(200).json({ ok: true });
    }

    const session = await getSession(String(chat_id));

    // Esperando descripción y monto
    if (session.state === 'esperando_desc') {
      const { desc, monto } = parseMonto(texto);
      if (!monto || monto <= 0) {
        await sendMessage(chat_id, '⚠️ No encontré el monto. Escribí así:\n`almuerzo 1500`');
        return res.status(200).json({ ok: true });
      }

      const userData = await getUserData(linked.user_id);
      const tipo = session.data.tipo;
      const catKey = tipo === 'diario' ? 'daily' : tipo === 'fijo' ? 'fijos' : 'cuotas';
      const cats = userData?.cats?.[catKey] || [];

      await saveSession(String(chat_id), 'esperando_cat', { ...session.data, desc, monto });
      await sendMessage(chat_id,
        `📝 *${desc}* — ${fmt(monto)}\n\n¿Qué categoría?`,
        catButtons(cats)
      );
      return res.status(200).json({ ok: true });
    }

    // Botón "➕ Nuevo gasto" o cualquier otro mensaje → mostrar menú de tipo
    await saveSession(String(chat_id), 'esperando_tipo', {});
    await sendMessage(chat_id, '¿Qué tipo de gasto querés cargar?', tipoButtons());

  } catch(err) {
    console.error('handler error:', err.message);
    await sendMessage(chat_id, '❌ Algo salió mal. Intentá de nuevo con /nuevo');
  }

  return res.status(200).json({ ok: true });
}
