// Panel admin: solo se activa para la propietaria (ver ADMIN_EMAILS en script.js y esAdmin() en firestore.rules).
(function(){
"use strict";
const $ = s => document.querySelector(s);
const S = () => window.Stock;
const ONLINE_MS = 5 * 60 * 1000;     // conectado = actividad en los últimos 5 minutos
const DAY_MS = 24 * 60 * 60 * 1000;

let unsubs = [], tick = null;
let blocked = [], sessions = [], errors = [], allMoves = [], todayMoves = [];
let connected = null;

const startOfDay = () => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); };
const fmtDate = ts => new Date(ts).toLocaleString("es-AR", {day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"});

function start(){
  stop();
  const {fs} = S();
  const err = what => e => { connected = false; renderHealth(); console.warn("Panel admin:", what, e.code); };
  unsubs.push(fs.doc("config/blocked").onSnapshot({includeMetadataChanges:true}, d => {
    blocked = (d.exists && d.data().emails) || [];
    connected = !d.metadata.fromCache;
    renderUsers(); renderHealth();
  }, err("bloqueados")));
  unsubs.push(fs.collection("sessions").onSnapshot(s => { sessions = s.docs.map(d => d.data()); renderUsers(); renderHealth(); }, err("sesiones")));
  unsubs.push(fs.collection("errors").orderBy("ts","desc").limit(50).onSnapshot(s => { errors = s.docs.map(d => ({id:d.id, ...d.data()})); renderErrors(); renderHealth(); }, err("errores")));
  unsubs.push(fs.collection("moves").orderBy("ts","desc").limit(300).onSnapshot(s => { allMoves = s.docs.map(d => d.data()); renderMoves(); }, err("historial")));
  unsubs.push(fs.collection("moves").where("ts", ">=", startOfDay()).onSnapshot(s => { todayMoves = s.docs.map(d => d.data()); renderUsers(); renderHealth(); }, err("movimientos de hoy")));
  unsubs.push(fs.doc("config/business").onSnapshot(d => {
    const b = (d.exists && d.data()) || {};
    [["#bizName","name"],["#bizAddress","address"],["#bizPhone","phone"],["#bizCuit","cuit"]].forEach(([sel,k]) => {
      if (document.activeElement !== $(sel)) $(sel).value = b[k] || "";
    });
  }, err("datos del comercio")));
  tick = setInterval(() => { renderUsers(); renderHealth(); }, 30 * 1000);
}
$("#bizForm").addEventListener("submit", async e => {
  e.preventDefault();
  const data = {
    name: $("#bizName").value.trim(), address: $("#bizAddress").value.trim(),
    phone: $("#bizPhone").value.trim(), cuit: $("#bizCuit").value.trim()
  };
  if (!data.name) return S().toast("Escribí al menos el nombre del comercio.");
  try { await S().fs.doc("config/business").set(data); S().toast("Datos del comercio guardados"); }
  catch(ex){ S().toast("No se pudieron guardar (" + ex.code + ")."); }
});
function stop(){
  unsubs.splice(0).forEach(u => u());
  clearInterval(tick);
}

/* ---------- estado general ---------- */
function renderHealth(){
  const online = navigator.onLine && connected !== false;
  const connBox = $("#hConnBox");
  $("#hConn").textContent = !navigator.onLine ? "Sin internet" : connected === false ? "Error con la base" : connected ? "Todo en orden" : "Conectando…";
  connBox.classList.toggle("good", online && connected === true);
  connBox.classList.toggle("bad", !online);

  const now = Date.now();
  $("#hOnline").textContent = sessions.filter(s => now - (s.lastSeen||0) < ONLINE_MS).length;
  const sod = startOfDay();
  $("#hMovesToday").textContent = todayMoves.filter(m => m.ts >= sod).length;
  const errs24 = errors.filter(e => now - e.ts < DAY_MS).length;
  $("#hErrors").textContent = errs24;
  $("#hErrBox").classList.toggle("bad", errs24 > 0);

  const badge = $("#adminBadge");
  badge.hidden = errs24 === 0;
  badge.textContent = errs24;
  badge.title = `${errs24} error(es) en las últimas 24 h`;
}

/* ---------- usuarios ---------- */
function renderUsers(){
  const {esc, timeAgo, me} = S();
  const now = Date.now(), sod = startOfDay();
  const bySession = new Map(sessions.map(s => [s.email, s]));
  // Primero los conectados, después por último ingreso.
  const emails = [...new Set([me.email, ...sessions.slice().sort((a,b) => (b.lastSeen||0) - (a.lastSeen||0)).map(s => s.email), ...blocked])];
  $("#userRows").innerHTML = emails.map(email => {
    const s = bySession.get(email);
    const isOnline = s && now - (s.lastSeen||0) < ONLINE_MS;
    const movs = todayMoves.filter(m => m.by === email && m.ts >= sod).length;
    const isMe = email === me.email;
    const isBlocked = blocked.includes(email);
    return `<tr data-email="${esc(email)}">
      <td><div class="who">
        ${s && s.photo ? `<img src="${esc(s.photo)}" alt="" referrerpolicy="no-referrer">` : ""}
        <div><div>${esc(s ? s.name : email)} ${isMe ? '<span class="tag">Propietaria</span>' : ""}${isBlocked ? '<span class="pill out">Bloqueado</span>' : ""}</div><div class="em">${esc(email)}</div></div>
      </div></td>
      <td class="t">${s ? (isOnline && !isBlocked ? '<span class="online"></span>Conectado ahora' : "hace " + timeAgo(s.lastSeen).replace("recién","un momento")) : "—"}</td>
      <td class="t">${s ? esc(s.device || "—") : "—"}</td>
      <td class="r num">${movs}</td>
      <td class="r">${isMe ? "" : isBlocked
        ? `<button class="btn sm" type="button" data-unblock>Desbloquear</button>`
        : `<button class="btn sm danger" type="button" data-block>Bloquear</button>`}</td>
    </tr>`;
  }).join("");
  const sel = $("#movesUser"), cur = sel.value;
  const known = [...new Set([...emails, ...allMoves.map(m => m.by).filter(Boolean)])];
  sel.innerHTML = '<option value="">Todos los usuarios</option>' + known.map(e => `<option${e===cur?" selected":""}>${esc(e)}</option>`).join("");
}
$("#userRows").addEventListener("click", async e => {
  const b = e.target.closest("[data-block],[data-unblock]"); if (!b) return;
  const email = b.closest("tr").dataset.email;
  const FV = firebase.firestore.FieldValue;
  if (b.hasAttribute("data-block") && !b.classList.contains("armed")) {
    b.classList.add("armed"); b.textContent = "Confirmar bloqueo";
    setTimeout(() => { b.classList.remove("armed"); b.textContent = "Bloquear"; }, 4000);
    return;
  }
  const block = b.hasAttribute("data-block");
  try {
    await S().fs.doc("config/blocked").set({emails: block ? FV.arrayUnion(email) : FV.arrayRemove(email)}, {merge:true});
    S().toast(block ? "Bloqueado: " + email + ". Ya no puede ver ni modificar el stock." : "Desbloqueado: " + email);
  } catch(ex){ S().toast("No se pudo guardar el cambio (" + ex.code + ")."); }
});

/* ---------- errores ---------- */
function renderErrors(){
  const {esc} = S();
  const el = $("#errorList");
  if (!errors.length) { el.innerHTML = '<li class="empty">Sin errores registrados. Todo funciona bien.</li>'; return; }
  el.innerHTML = errors.map(x => `<li>
    <div class="row"><span>${esc(x.where)} · ${esc(x.email)}</span><span class="meta">${fmtDate(x.ts)}</span></div>
    <div class="msg">${esc(x.message)}</div>
    <div class="meta">${esc(x.device || "")}${x.online === false ? " · sin internet" : ""}</div>
  </li>`).join("");
}
$("#btnClearErrors").addEventListener("click", async () => {
  if (!errors.length) return;
  const batch = S().fs.batch();
  errors.forEach(x => batch.delete(S().fs.doc("errors/" + x.id)));
  try { await batch.commit(); S().toast("Errores borrados"); } catch(ex){ S().toast("No se pudieron borrar (" + ex.code + ")."); }
});

/* ---------- historial completo ---------- */
function renderMoves(){
  const {esc, int} = S();
  const who = $("#movesUser").value;
  const list = allMoves.filter(m => !who || m.by === who);
  const src = {scan:"Escáner", manual:"Botón +/−", alta:"Alta", ajuste:"Edición", cuenta:"Cuenta mensual", venta:"Venta", "anulación":"Venta borrada"};
  $("#allMoves").innerHTML = list.map(m => {
    const d = m.type === "set" ? "=" + m.qtyAfter : (m.delta > 0 ? "+" : "") + m.delta;
    const color = m.type === "set" ? "--accent" : m.delta >= 0 ? "--ok" : "--bad";
    return `<tr>
      <td class="t">${fmtDate(m.ts)}</td>
      <td>${esc(m.name)}</td>
      <td class="r mono" style="color:var(${color})">${esc(d)}</td>
      <td class="r num">${int(m.qtyAfter)}</td>
      <td>${esc(m.byName || m.by || "—")}</td>
      <td class="t">${esc(src[m.source] || m.source || "")}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" style="color:var(--muted)">Sin movimientos.</td></tr>`;
}
$("#movesUser").addEventListener("change", renderMoves);
window.addEventListener("online", renderHealth);
window.addEventListener("offline", renderHealth);

/* ---------- borrar datos de prueba ---------- */
const pad2 = n => String(n).padStart(2, "0");
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; };
$("#clDay").value = todayKey();
let cleanupPlan = null;

// "Toda la caja" ya incluye el día: no tiene sentido marcar las dos.
$("#clAllSales").addEventListener("change", () => { if ($("#clAllSales").checked) $("#clDaySales").checked = false; resetCleanup(); });
$("#clDaySales").addEventListener("change", () => { if ($("#clDaySales").checked) $("#clAllSales").checked = false; resetCleanup(); });
["#clDay","#clDebts","#clAccounts","#clRestock"].forEach(s => $(s).addEventListener("change", resetCleanup));
function resetCleanup(){ cleanupPlan = null; $("#cleanupConfirm").hidden = true; $("#btnCleanup").disabled = false; }

$("#cleanupForm").addEventListener("submit", async e => {
  e.preventDefault();
  const {fs, money} = S();
  const opt = {
    day: $("#clDaySales").checked ? $("#clDay").value : null,
    allSales: $("#clAllSales").checked,
    debts: $("#clDebts").checked,
    accounts: $("#clAccounts").checked,
    restock: $("#clRestock").checked
  };
  if (!opt.day && !opt.allSales && !opt.debts && !opt.accounts) { S().toast("Marcá qué querés borrar."); return; }
  const btn = $("#btnCleanup"); btn.disabled = true; btn.textContent = "Revisando…";
  try {
    const get = async q => (await q.get()).docs;
    const plan = {opt, sales: [], debts: [], accounts: [], entries: [], months: []};
    if (opt.allSales) plan.sales = await get(fs.collection("sales"));
    else if (opt.day) plan.sales = await get(fs.collection("sales").where("day", "==", opt.day));
    if (opt.debts) plan.debts = await get(fs.collection("debts"));
    if (opt.accounts) {
      [plan.accounts, plan.entries, plan.months] = await Promise.all([
        get(fs.collection("accounts")), get(fs.collection("accountEntries")), get(fs.collection("accountMonths"))
      ]);
    }
    cleanupPlan = plan;
    const total = plan.sales.reduce((s, d) => s + (+d.data().amount || 0), 0);
    const [y, m, d] = (opt.day || "--").split("-");
    const parts = [];
    if (opt.allSales || opt.day) parts.push(`<b>${plan.sales.length}</b> venta(s) y cobro(s) ${opt.allSales ? "de toda la caja" : `del ${d}/${m}/${y}`} (${money(total)})`);
    if (opt.debts) parts.push(`<b>${plan.debts.length}</b> deuda(s)`);
    if (opt.accounts) parts.push(`<b>${plan.accounts.length}</b> cuenta(s) mensual(es) con <b>${plan.entries.length}</b> retiro(s)${opt.restock ? " (los productos vuelven al stock)" : ""}`);
    const empty = !plan.sales.length && !plan.debts.length && !plan.accounts.length && !plan.entries.length && !plan.months.length;
    $("#cleanupSummary").innerHTML = empty
      ? "No hay nada para borrar con lo que marcaste."
      : "Se van a borrar: " + parts.join(", ") + ". <b>Esto no se puede deshacer.</b>";
    $("#btnCleanupOk").hidden = empty;
    $("#cleanupConfirm").hidden = false;
  } catch(ex){
    S().toast("No se pudo revisar (" + (ex.code || "error") + ").");
    btn.disabled = false;
  }
  btn.textContent = "Revisar qué se va a borrar";
});
$("#btnCleanupCancel").addEventListener("click", resetCleanup);

$("#btnCleanupOk").addEventListener("click", async () => {
  const plan = cleanupPlan; if (!plan) return;
  const {fs} = S();
  const ok = $("#btnCleanupOk"); ok.disabled = true; ok.textContent = "Borrando…";
  try {
    // Cobros que quedan "sueltos": si no se borran sus deudas o cuentas, deshacer lo que marcaron.
    for (const s of plan.sales) {
      const data = s.data();
      const keepsDebt = data.kind === "cobro-deuda" && !plan.opt.debts;
      const keepsAccount = data.kind === "cuenta" && !plan.opt.accounts;
      const restocks = data.items && plan.opt.restock;
      if (keepsDebt || keepsAccount || restocks) await window.Caja.undoSale(s.id, data);
    }
    // Devolver al stock lo que se llevaron las cuentas (antes de borrar los retiros).
    if (plan.opt.restock) {
      for (const en of plan.entries) {
        const e = en.data();
        if (e.code && S().products.has(e.code)) await S().changeStock(e.code, +e.qty || 0, "cuenta");
      }
    }
    // Borrar todo en tandas (Firestore admite hasta 500 operaciones por tanda).
    const refs = [...plan.sales, ...plan.debts, ...plan.accounts, ...plan.entries, ...plan.months].map(d => d.ref);
    for (let i = 0; i < refs.length; i += 400) {
      const batch = fs.batch();
      refs.slice(i, i + 400).forEach(r => batch.delete(r));
      await batch.commit();
    }
    S().toast(`Listo: se borraron ${refs.length} registro(s) de prueba.`);
    resetCleanup();
  } catch(ex){
    S().toast("Se cortó a mitad de camino (" + (ex.code || "error") + "). Volvé a revisar y borrar lo que quedó.");
    resetCleanup();
  }
  ok.disabled = false; ok.textContent = "Sí, borrar todo esto";
});

window.AdminPanel = {start, stop};
})();
