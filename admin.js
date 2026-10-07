// Panel admin: solo se activa para la propietaria (ver ADMIN_EMAILS en script.js y esAdmin() en firestore.rules).
(function(){
"use strict";
const $ = s => document.querySelector(s);
const S = () => window.Stock;
const ONLINE_MS = 5 * 60 * 1000;     // conectado = actividad en los últimos 5 minutos
const DAY_MS = 24 * 60 * 60 * 1000;

let unsubs = [], tick = null;
let access = [], sessions = [], denied = [], errors = [], allMoves = [], todayMoves = [];
let connected = null;

const startOfDay = () => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); };
const fmtDate = ts => new Date(ts).toLocaleString("es-AR", {day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"});

function start(){
  stop();
  const {fs} = S();
  const err = what => e => { connected = false; renderHealth(); console.warn("Panel admin:", what, e.code); };
  unsubs.push(fs.doc("config/access").onSnapshot({includeMetadataChanges:true}, d => {
    access = (d.exists && d.data().users) || [];
    connected = !d.metadata.fromCache;
    renderUsers(); renderHealth();
  }, err("usuarios")));
  unsubs.push(fs.collection("sessions").onSnapshot(s => { sessions = s.docs.map(d => d.data()); renderUsers(); renderHealth(); }, err("sesiones")));
  unsubs.push(fs.collection("denied").orderBy("ts","desc").limit(50).onSnapshot(s => { denied = s.docs.map(d => ({id:d.id, ...d.data()})); renderDenied(); renderHealth(); }, err("intentos")));
  unsubs.push(fs.collection("errors").orderBy("ts","desc").limit(50).onSnapshot(s => { errors = s.docs.map(d => ({id:d.id, ...d.data()})); renderErrors(); renderHealth(); }, err("errores")));
  unsubs.push(fs.collection("moves").orderBy("ts","desc").limit(300).onSnapshot(s => { allMoves = s.docs.map(d => d.data()); renderMoves(); }, err("historial")));
  unsubs.push(fs.collection("moves").where("ts", ">=", startOfDay()).onSnapshot(s => { todayMoves = s.docs.map(d => d.data()); renderUsers(); renderHealth(); }, err("movimientos de hoy")));
  tick = setInterval(() => { renderUsers(); renderHealth(); }, 30 * 1000);
}
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

  const pending = denied.length + errs24;
  const badge = $("#adminBadge");
  badge.hidden = pending === 0;
  badge.textContent = pending;
  badge.title = `${denied.length} intento(s) de ingreso · ${errs24} error(es)`;
}

/* ---------- usuarios ---------- */
function renderUsers(){
  const {esc, timeAgo, me} = S();
  const now = Date.now(), sod = startOfDay();
  const bySession = new Map(sessions.map(s => [s.email, s]));
  const emails = [...new Set([me.email, ...access])];
  $("#userRows").innerHTML = emails.map(email => {
    const s = bySession.get(email);
    const isOnline = s && now - (s.lastSeen||0) < ONLINE_MS;
    const movs = todayMoves.filter(m => m.by === email && m.ts >= sod).length;
    const isMe = email === me.email;
    return `<tr data-email="${esc(email)}">
      <td><div class="who">
        ${s && s.photo ? `<img src="${esc(s.photo)}" alt="" referrerpolicy="no-referrer">` : ""}
        <div><div>${esc(s ? s.name : email)} ${isMe ? '<span class="tag">Propietaria</span>' : ""}</div><div class="em">${esc(email)}</div></div>
      </div></td>
      <td class="t">${s ? (isOnline ? '<span class="online"></span>Conectado ahora' : "hace " + timeAgo(s.lastSeen).replace("recién","un momento")) : "Nunca entró"}</td>
      <td class="t">${s ? esc(s.device || "—") : "—"}</td>
      <td class="r num">${movs}</td>
      <td class="r">${isMe ? "" : `<button class="btn sm danger" type="button" data-remove>Quitar acceso</button>`}</td>
    </tr>`;
  }).join("");
  const sel = $("#movesUser"), cur = sel.value;
  const known = [...new Set([...emails, ...allMoves.map(m => m.by).filter(Boolean)])];
  sel.innerHTML = '<option value="">Todos los usuarios</option>' + known.map(e => `<option${e===cur?" selected":""}>${esc(e)}</option>`).join("");
}
$("#userRows").addEventListener("click", async e => {
  const b = e.target.closest("[data-remove]"); if (!b) return;
  const email = b.closest("tr").dataset.email;
  if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmar"; setTimeout(() => { b.classList.remove("armed"); b.textContent = "Quitar acceso"; }, 4000); return; }
  try {
    await S().fs.doc("config/access").set({users: firebase.firestore.FieldValue.arrayRemove(email)}, {merge:true});
    S().toast("Se quitó el acceso a " + email);
  } catch(ex){ S().toast("No se pudo quitar el acceso (" + ex.code + ")."); }
});
async function authorize(email){
  email = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { S().toast("Escribí un correo válido."); return false; }
  try {
    await S().fs.doc("config/access").set({users: firebase.firestore.FieldValue.arrayUnion(email)}, {merge:true});
    S().toast("Acceso autorizado para " + email);
    return true;
  } catch(ex){ S().toast("No se pudo autorizar (" + ex.code + ")."); return false; }
}
$("#addUserForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (await authorize($("#newUserEmail").value)) $("#newUserEmail").value = "";
});

/* ---------- intentos sin permiso ---------- */
function renderDenied(){
  const {esc} = S();
  const el = $("#deniedList");
  if (!denied.length) { el.innerHTML = '<li class="empty">Nadie intentó entrar sin permiso.</li>'; return; }
  el.innerHTML = denied.map(d => `<li data-id="${esc(d.id)}" data-email="${esc(d.email)}">
    <div class="row"><b>${esc(d.name || d.email)}</b><span class="meta">${fmtDate(d.ts)}</span></div>
    <div class="meta">${esc(d.email)} · ${esc(d.device || "")}</div>
    <div class="row" style="justify-content:flex-start">
      <button class="btn sm primary" type="button" data-act="allow">Autorizar</button>
      <button class="btn sm" type="button" data-act="dismiss">Descartar</button>
    </div>
  </li>`).join("");
}
$("#deniedList").addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const li = b.closest("li");
  if (b.dataset.act === "allow" && !(await authorize(li.dataset.email))) return;
  S().fs.doc("denied/" + li.dataset.id).delete().catch(() => {});
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
  const src = {scan:"Escáner", manual:"Botón +/−", alta:"Alta", ajuste:"Edición"};
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

window.AdminPanel = {start, stop};
})();
