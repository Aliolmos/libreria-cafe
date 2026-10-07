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
