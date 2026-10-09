
(function(){
"use strict";

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const money = n => "$" + (Number(n)||0).toLocaleString("es-AR",{minimumFractionDigits:2,maximumFractionDigits:2});
const int = n => (Number(n)||0).toLocaleString("es-AR");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const docId = code => "p_" + String(code).replace(/[^A-Za-z0-9_\-.:@+]/g, c => "~" + c.charCodeAt(0).toString(16));
function toast(msg){
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  $("#toasts").appendChild(t); setTimeout(() => t.remove(), 3200);
}
function timeAgo(ts){
  const s = Math.round((Date.now() - ts)/1000);
  if (s < 60) return "recién";
  if (s < 3600) return Math.floor(s/60) + " min";
  if (s < 86400) return Math.floor(s/3600) + " h";
  return new Date(ts).toLocaleDateString("es-AR",{day:"2-digit",month:"2-digit"});
}
function ean13Check(d12){
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+d12[i]) * (i % 2 ? 3 : 1);
  return String((10 - sum % 10) % 10);
}
const isEAN13 = c => /^\d{13}$/.test(c) && ean13Check(c.slice(0,12)) === c[12];

/* ---------- estado ---------- */
let products = new Map();   // code -> producto
let moves = [];
let mode = "sell";
let sort = {key:"name", dir:1};
let editing = null;          // código original en edición
let labelProduct = null;
let readOnly = false;

/* ---------- Firebase: login + base de datos en la nube ---------- */
firebase.initializeApp(window.FIREBASE_CONFIG);
const auth = firebase.auth();
const fs = firebase.firestore();
// Caché offline: si se corta internet se sigue escaneando y se sincroniza al volver.
fs.enablePersistence({synchronizeTabs:true}).catch(() => {});
const increment = n => firebase.firestore.FieldValue.increment(n);

function makeFirestoreStore(){
  const col = fs.collection("products");
  const mv = fs.collection("moves");
  const unsubs = [];
  return {
    onProducts(cb){
      unsubs.push(col.onSnapshot({includeMetadataChanges:true}, s => {
        cb(s.docs.map(d => d.data()));
        if (s.metadata.fromCache && !navigator.onLine) setStatus("local","Sin internet · los cambios se guardan cuando vuelva la conexión");
        else setStatus("live","Conectado · " + (auth.currentUser?.email || ""));
      }, e => {
        reportError("conexión", e.code);
        if (e.code === "permission-denied") setStatus("bad","Tu cuenta no tiene permiso para ver el stock (puede estar bloqueada).");
        else setStatus("bad","Sin conexión con la base (" + e.code + ")");
      }));
    },
    onMoves(cb){
      unsubs.push(mv.orderBy("ts","desc").limit(40).onSnapshot(s => cb(s.docs.map(d => d.data())), () => {}));
    },
    save: p => col.doc(docId(p.code)).set(p),
    addQty: (code, delta) => col.doc(docId(code)).update({qty: increment(delta), updatedAt: Date.now()}),
    remove: code => col.doc(docId(code)).delete(),
    log: m => mv.add({...m, by: me.email, byName: me.name}),
    stop(){ unsubs.splice(0).forEach(u => u()); }
  };
}

let store = null;
function setStatus(kind, text){
  $("#statusDot").className = "dot " + (kind === "live" ? "live" : kind === "local" ? "local" : "");
  $("#statusText").textContent = text;
}

/* ---------- roles y sesión ---------- */
// Tiene que coincidir con la lista de esAdmin() en firestore.rules.
const ADMIN_EMAILS = ["aliolmos19@gmail.com"];
let me = null;            // {uid, email, name, photo, isAdmin}
let heartbeat = null;

function showScreen(id){
  ["#bootScreen","#loginScreen","#deniedScreen","#app"].forEach(s => $(s).hidden = s !== id);
}
function deviceName(){
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iPhone/iPad" : /Windows/i.test(ua) ? "Windows" : /Mac/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "Otro";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  return br + " en " + os;
}

async function onSignedIn(u){
  showScreen("#bootScreen");
  const email = (u.email || "").toLowerCase();
  me = {uid:u.uid, email, name:u.displayName || email, photo:u.photoURL || "", isAdmin: ADMIN_EMAILS.includes(email)};
  // Cualquier cuenta de Google entra, salvo que la propietaria la haya bloqueado.
  if (!me.isAdmin) {
    try {
      const b = await fs.doc("config/blocked").get();
      if (b.exists && (b.data().emails || []).includes(email)) {
        $("#deniedEmail").textContent = email;
        showScreen("#deniedScreen");
        return;
      }
    } catch(e){ /* sin internet: entrar igual con la caché offline */ }
  }
  startApp();
}

function touchSession(){
  if (!me) return;
  fs.doc("sessions/" + me.uid).set({
    email: me.email, name: me.name, photo: me.photo, device: deviceName(),
    lastSeen: Date.now(), role: me.isAdmin ? "admin" : "usuario"
  }, {merge:true}).catch(() => {});
}

function startApp(){
  showScreen("#app");
  setStatus("", "Conectando…");
  $("#userName").textContent = me.name;
  const img = $("#userPhoto");
  if (me.photo) { img.src = me.photo; img.hidden = false; } else img.hidden = true;
  $("#tabAdmin").hidden = !me.isAdmin;
  showView("stock");
  store = makeFirestoreStore();
  store.onProducts(list => { products = new Map(list.map(p => [p.code, p])); render(); });
  store.onMoves(list => { moves = list; renderHistory(); });
  touchSession();
  heartbeat = setInterval(() => { if (document.visibilityState === "visible") touchSession(); }, 2 * 60 * 1000);
  if (window.Caja) window.Caja.start();
  if (me.isAdmin && window.AdminPanel) window.AdminPanel.start();
  scanInput.focus();
}
function stopApp(){
  if (store) store.stop();
  if (window.AdminPanel) window.AdminPanel.stop();
  if (window.Caja) window.Caja.stop();
  clearInterval(heartbeat);
  store = null; me = null; products = new Map(); moves = [];
  showScreen("#loginScreen");
}

function showView(v){
  $("#stockView").hidden = v !== "stock";
  $("#cajaView").hidden = v !== "caja";
  $("#adminView").hidden = v !== "admin";
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  if (v === "stock") scanInput.focus();
}
document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));

/* ---------- registro de errores para el panel admin ---------- */
let errorsSent = 0;
function reportError(where, message){
  if (!me || errorsSent >= 10) return;   // tope por sesión para no llenar la base
  errorsSent++;
  fs.collection("errors").add({
    ts: Date.now(), where, message: String(message || "").slice(0, 500),
    email: me.email, device: deviceName(), online: navigator.onLine
  }).catch(() => {});
}
window.addEventListener("error", e => reportError("página", (e.message || "Error") + (e.filename ? " · " + e.filename.split("/").pop() + ":" + e.lineno : "")));
window.addEventListener("unhandledrejection", e => reportError("página", e.reason && (e.reason.message || e.reason)));
async function guard(fn){
  if (!store) return false;
  try { await fn(); return true; }
  catch(e){
    reportError("guardar", (e && (e.code || e.message)) || e);
    if (e && e.code === "permission-denied") toast("Tu usuario no tiene permiso para modificar el stock.");
    else if (e && e.code === "resource-exhausted") toast("Se alcanzó el límite diario del plan gratis de Firebase. Vuelve a funcionar mañana.");
    else toast("No se pudo guardar. Revisá la conexión y probá de nuevo.");
    return false;
  }
}

/* ---------- render ---------- */
function status(p){
  const q = Number(p.qty)||0, min = Number(p.min)||0;
  if (q <= 0) return "out";
  if (q <= min) return "low";
  return "ok";
}
const statusLabel = {ok:"OK", low:"Bajo", out:"Agotado"};

/* ---------- categorías ---------- */
const CATEGORIES = {
  "Librería": [
    "Cuadernos A4", "Cuadernos oficio", "Cuadernos chicos y anotadores", "Carpetas y repuestos",
    "Hojas, resmas y papeles", "Cartulinas, afiches y papel glasé", "Lápices de colores", "Lápices negros",
    "Lapiceras y biromes", "Marcadores y resaltadores", "Gomas y sacapuntas", "Reglas y geometría",
    "Adhesivos y plasticolas", "Tijeras y cutters", "Témperas y pinturas", "Correctores",
    "Mochilas y cartucheras", "Agendas", "Fotocopias e impresiones", "Otros de librería"
  ],
  "Perfumería": [
    "Perfumes y colonias", "Cremas corporales", "Cremas faciales", "Maquillaje",
    "Cuidado del cabello", "Jabones y cuidado personal", "Desodorantes", "Protector solar",
    "Sets de regalo", "Otros de perfumería"
  ]
};
const groupOf = cat => Object.keys(CATEGORIES).find(g => CATEGORIES[g].includes(cat)) || "";
function fillCategorySelect(selected){
  const known = groupOf(selected);
  $("#fCat").innerHTML = '<option value="">Sin categoría</option>' +
    Object.entries(CATEGORIES).map(([g, subs]) =>
      `<optgroup label="${esc(g)}">${subs.map(s => `<option${s === selected ? " selected" : ""}>${esc(s)}</option>`).join("")}</optgroup>`).join("") +
    // Una categoría vieja (anterior a esta lista) se conserva para no perderla al editar.
    (selected && !known ? `<optgroup label="Anterior"><option selected>${esc(selected)}</option></optgroup>` : "");
}

function render(){
  const all = [...products.values()];
  // métricas
  $("#mItems").textContent = int(all.length);
  $("#mUnits").textContent = int(all.reduce((a,p) => a + Math.max(0, Number(p.qty)||0), 0));
  $("#mValue").textContent = money(all.reduce((a,p) => a + Math.max(0, Number(p.qty)||0) * (Number(p.price)||0), 0));
  const lowN = all.filter(p => status(p) !== "ok").length;
  $("#mLow").textContent = int(lowN);
  $("#mLowBox").classList.toggle("alert", lowN > 0);

  // categorías: Librería y Perfumería, más las viejas que no estén en la lista
  const cf = $("#catFilter"), cur = cf.value;
  const legacy = [...new Set(all.map(p => (p.cat||"").trim()).filter(c => c && !groupOf(c)))].sort((a,b) => a.localeCompare(b,"es"));
  const opt = (v, label) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  cf.innerHTML = opt("", "Todas las categorías") +
    Object.entries(CATEGORIES).map(([g, subs]) =>
      `<optgroup label="${esc(g)}">${opt("g:" + g, "Toda " + (g === "Librería" ? "la librería" : "la perfumería"))}${subs.map(s => opt("c:" + s, s)).join("")}</optgroup>`).join("") +
    (legacy.length ? `<optgroup label="Otras">${legacy.map(c => opt("c:" + c, c)).join("")}</optgroup>` : "");

  // filtros
  const q = $("#search").value.trim().toLowerCase();
  const cat = cf.value, sf = $("#stockFilter").value;
  const inCat = p => !cat || (cat.startsWith("g:") ? groupOf((p.cat||"").trim()) === cat.slice(2) : (p.cat||"").trim() === cat.slice(2));
  let list = all.filter(p =>
    (!q || [p.name,p.code,p.cat].some(v => String(v||"").toLowerCase().includes(q))) &&
    inCat(p) &&
    (!sf || status(p) === sf));
  const val = p => sort.key === "value" ? (Number(p.qty)||0)*(Number(p.price)||0) : p[sort.key];
  list.sort((a,b) => {
    const x = val(a), y = val(b);
    if (typeof x === "number" || typeof y === "number") return ((Number(x)||0) - (Number(y)||0)) * sort.dir;
    return String(x||"").localeCompare(String(y||""),"es") * sort.dir;
  });

  $("#emptyState").hidden = all.length > 0;
  $("#rows").innerHTML = list.map(p => {
    const st = status(p);
    return `<tr data-code="${esc(p.code)}">
      <td class="c-name"><div class="p-name">${esc(p.name)}</div>${p.cat ? `<div class="p-cat">${esc([groupOf(p.cat), p.cat].filter(Boolean).join(" · "))}</div>` : ""}</td>
      <td class="c-code"><span class="code">${esc(p.code)}</span></td>
      <td class="c-price r num">${money(p.price)}</td>
      <td class="c-stock"><span class="stock-cell">
        <button class="btn icon-btn" type="button" data-act="dec" aria-label="Restar uno">−</button>
        <span class="q">${int(p.qty)}</span>
        <button class="btn icon-btn" type="button" data-act="inc" aria-label="Sumar uno">+</button>
        <span class="pill ${st}">${statusLabel[st]}</span>
      </span></td>
      <td class="c-val r num">${money((Number(p.qty)||0)*(Number(p.price)||0))}</td>
      <td class="c-act"><div class="row-actions">
        <button class="btn sm" type="button" data-act="label">Etiqueta</button>
        <button class="btn sm" type="button" data-act="edit">Editar</button>
      </div></td>
    </tr>`;
  }).join("") || (all.length ? `<tr><td colspan="6" style="color:var(--muted);padding:20px 12px">Ningún producto coincide con el filtro.</td></tr>` : "");
  if (cart.size) renderCart();   // precios y stock del ticket al día
  document.querySelectorAll("th[data-sort]").forEach(th => {
    const base = th.textContent.replace(/ [↑↓]$/,"");
    th.textContent = base + (th.dataset.sort === sort.key ? (sort.dir > 0 ? " ↑" : " ↓") : "");
  });
}

function renderHistory(){
  const el = $("#history");
  if (!moves.length) { el.innerHTML = '<li class="empty">Sin movimientos todavía.</li>'; return; }
  el.innerHTML = moves.map(m => {
    const cls = m.type === "set" ? "set" : m.delta >= 0 ? "in" : "out";
    const d = m.type === "set" ? "=" + m.qtyAfter : (m.delta > 0 ? "+" : "") + m.delta;
    return `<li><span class="d ${cls}">${esc(d)}</span><span class="n" title="${esc(m.name)}">${esc(m.name)}</span><span class="t">${timeAgo(m.ts)}</span></li>`;
  }).join("");
}
setInterval(renderHistory, 60000);

/* ---------- movimientos de stock ---------- */
async function changeStock(code, delta, source){
  const p = products.get(code); if (!p) return;
  const next = (Number(p.qty)||0) + delta;
  // increment() suma en el servidor: si dos personas escanean a la vez, se cuentan las dos.
  const ok = await guard(async () => {
    await store.addQty(code, delta);
    await store.log({code, name:p.name, delta, type: delta >= 0 ? "in" : "out", qtyAfter: next, ts: Date.now(), source});
  });
  if (ok) highlight(code);
  return ok ? next : null;
}
function highlight(code){
  requestAnimationFrame(() => {
    const tr = [...document.querySelectorAll("#rows tr")].find(r => r.dataset.code === code);
    if (tr) { tr.classList.remove("hl"); void tr.offsetWidth; tr.classList.add("hl"); }
  });
}

/* ---------- escaneo ---------- */
const scanInput = $("#scan");
// Un código: sin espacios y con al menos un número. Cualquier otra cosa se toma como nombre.
const looksLikeCode = s => /^[A-Za-z0-9\-.\/]+$/.test(s) && /\d/.test(s);
async function handleScan(raw){
  const code = String(raw).trim();
  if (!code || !store) return;
  hideSug();
  const p = products.get(code);
  const res = $("#result");
  res.className = "result";
  void res.offsetWidth;
  if (!p) {
    const isCode = looksLikeCode(code);
    res.classList.add("flash-miss");
    res.innerHTML = isCode
      ? `<span class="label">Código nuevo</span><div class="r-name mono">${esc(code)}</div><div class="empty">No está en el inventario. Completá el alta para empezar a contarlo.</div>`
      : `<span class="label">Producto nuevo</span><div class="r-name">${esc(code)}</div><div class="empty">No hay ningún producto con ese nombre. Completá el alta para agregarlo.</div>`;
    beep(330);
    if (!readOnly) isCode ? openProduct(null, code) : openProduct(null, "", code);
    return;
  }
  const qty = Math.max(1, parseInt($("#scanQty").value,10) || 1);
  if (mode === "sell") { addToCart(code, qty); beep(880); return; }
  let after = Number(p.qty)||0, delta = 0;
  if (mode !== "look") {
    delta = mode === "in" ? qty : -qty;
    const r = await changeStock(code, delta, "scan");
    if (r === null) return;
    after = r;
  } else highlight(code);
  const st = status({...p, qty:after});
  res.classList.add(mode === "in" ? "flash-in" : "flash-look");
  res.innerHTML = `
    <span class="label">${mode === "look" ? "Consulta" : "Entrada registrada"} · <span class="mono">${esc(code)}</span></span>
    <div class="r-name">${esc(p.name)}</div>
    <div class="r-row">
      <span><span class="r-big num">${int(after)}</span> <span class="label">en stock</span></span>
      ${delta ? `<span class="r-delta" style="color:var(${delta>0?"--ok":"--bad"})">${delta>0?"+":""}${delta}</span>` : ""}
      <span class="pill ${st}">${statusLabel[st]}</span>
      <span class="num">${money(p.price)} c/u</span>
    </div>`;
  beep(880);
}
function showAdded(p){
  const res = $("#result");
  res.className = "result"; void res.offsetWidth; res.classList.add("flash-in");
  const st = status(p);
  res.innerHTML = `
    <span class="label">Producto agregado · <span class="mono">${esc(p.code)}</span></span>
    <div class="r-name">${esc(p.name)}</div>
    <div class="r-row">
      <span><span class="r-big num">${int(p.qty)}</span> <span class="label">en stock</span></span>
      <span class="pill ${st}">${statusLabel[st]}</span>
      <span class="num">${money(p.price)} c/u</span>
    </div>`;
}

/* ---------- búsqueda manual (sin escáner) ---------- */
const sugList = $("#sugList");
let sugItems = [], sugIndex = -1;
function hideSug(){ sugList.hidden = true; sugItems = []; sugIndex = -1; scanInput.setAttribute("aria-expanded","false"); }
function renderSug(){
  const q = scanInput.value.trim().toLowerCase();
  if (!q) return hideSug();
  sugItems = [...products.values()]
    .filter(p => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q))
    .sort((a,b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name,"es"))
    .slice(0, 8);
  const exact = products.has(scanInput.value.trim());
  sugList.innerHTML = sugItems.map((p,i) => `
    <li role="option" data-i="${i}" aria-selected="${i === sugIndex}">
      <span class="s-name">${esc(p.name)}</span><span class="s-qty">${int(p.qty)}</span>
      <span class="s-code">${esc(p.code)}</span><span class="s-price">${money(p.price)}</span>
    </li>`).join("") +
    (exact || readOnly ? "" : `<li role="option" class="s-new" data-new="1">+ Agregar “${esc(scanInput.value.trim())}” como producto nuevo</li>`);
  sugList.hidden = false;
  scanInput.setAttribute("aria-expanded","true");
}
function pickSug(i){
  const p = sugItems[i]; scanInput.value = "";
  if (p) handleScan(p.code);
}
scanInput.addEventListener("input", () => { sugIndex = -1; renderSug(); });
scanInput.addEventListener("blur", () => setTimeout(hideSug, 150));
sugList.addEventListener("mousedown", e => {
  const li = e.target.closest("li"); if (!li) return;
  e.preventDefault();
  if (li.dataset.new) {
    const v = scanInput.value.trim(); scanInput.value = ""; hideSug();
    looksLikeCode(v) ? openProduct(null, v) : openProduct(null, "", v);
    return;
  }
  pickSug(+li.dataset.i);
});

scanInput.addEventListener("keydown", e => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!sugItems.length) return;
    e.preventDefault();
    sugIndex = (sugIndex + (e.key === "ArrowDown" ? 1 : -1) + sugItems.length) % sugItems.length;
    renderSug();
    return;
  }
  if (e.key === "Escape") { hideSug(); return; }
  if (e.key === "Enter") {
    e.preventDefault();
    const v = scanInput.value.trim();
    if (sugIndex >= 0) return pickSug(sugIndex);
    // Enter con el campo vacío en modo Venta: confirmar la venta.
    if (!v && mode === "sell" && cart.size) return confirmSale();
    scanInput.value = "";
    if (products.has(v)) return handleScan(v);
    // Nombre escrito a mano que coincide con un solo producto: usar ese.
    if (!looksLikeCode(v) && sugItems.length === 1) return handleScan(sugItems[0].code);
    handleScan(v);
  }
});

// Captura global: un escáner USB "teclea" muy rápido y termina con Enter.
let buf = "", lastT = 0, gaps = [];
document.addEventListener("keydown", e => {
  const t = e.target;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (typing || document.querySelector("dialog[open]") || $("#stockView").hidden) { buf = ""; return; }
  const now = performance.now();
  if (now - lastT > 80) { buf = ""; gaps = []; }
  else gaps.push(now - lastT);
  lastT = now;
  if (e.key === "Enter") {
    const avg = gaps.length ? gaps.reduce((a,b) => a+b, 0) / gaps.length : 999;
    if (buf.length >= 4 && avg < 50) { e.preventDefault(); handleScan(buf); }
    buf = ""; gaps = [];
    return;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) buf += e.key;
});

const MODE_HINTS = {
  sell: "Venta: escaneá o buscá cada producto que se llevan, elegí cómo pagó y confirmá. Se descuenta del stock y se suma a la Caja del día.",
  in: "Entrada: cada escaneo suma al stock (mercadería que llegó).",
  look: "Consultar: muestra el stock y el precio sin cambiar nada."
};
function setMode(m){
  mode = m;
  document.querySelectorAll(".seg button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.mode === m)));
  $("#armedHint").textContent = MODE_HINTS[m] + " Sin escáner: escribí el nombre o el código y elegí de la lista.";
  $("#cart").hidden = m !== "sell";
  $("#result").hidden = m === "sell";
  scanInput.focus();
}
document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));

/* ---------- venta: ticket en curso ---------- */
const cart = new Map();   // código -> cantidad
let payMethod = null;
const round2 = n => Math.round(n * 100) / 100;
const PAY_LABELS = {efectivo:"Efectivo", transferencia:"Transferencia / MP", tarjeta:"Tarjeta"};
const localDayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

function addToCart(code, qty){
  cart.set(code, (cart.get(code) || 0) + qty);
  renderCart(code);
}
function cartLines(){
  return [...cart].filter(([code]) => products.has(code)).map(([code, qty]) => {
    const p = products.get(code);
    const unit = Number(p.price) || 0;
    return {code, name: p.name, qty, unitPrice: unit, amount: round2(unit * qty), stock: Number(p.qty) || 0};
  });
}
function renderCart(justAdded){
  const lines = cartLines();
  const el = $("#cartItems");
  el.innerHTML = lines.length ? lines.map(l => `
    <li data-code="${esc(l.code)}"${l.code === justAdded ? ' class="just"' : ""}>
      <div class="ci-name"><b>${esc(l.name)}</b><span class="meta">${money(l.unitPrice)} c/u${l.qty > l.stock ? ` · <span class="warn-text">quedan ${int(l.stock)} en stock</span>` : ""}</span></div>
      <span class="stock-cell">
        <button class="btn icon-btn" type="button" data-cart="dec" aria-label="Uno menos">−</button>
        <span class="q">${int(l.qty)}</span>
        <button class="btn icon-btn" type="button" data-cart="inc" aria-label="Uno más">+</button>
      </span>
      <b class="num ci-sub">${money(l.amount)}</b>
      <button class="link-btn" type="button" data-cart="del" aria-label="Sacar del ticket">✕</button>
    </li>`).join("") : '<li class="empty">Escaneá o buscá los productos que se llevan. Se van sumando acá.</li>';
  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  $("#cartTotal").textContent = money(total);
  $("#cartClear").hidden = !lines.length;
  document.querySelectorAll("[data-pay]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.pay === payMethod)));
  const btn = $("#cartConfirm");
  btn.disabled = !lines.length || !payMethod;
  btn.textContent = !lines.length ? "Agregá productos para vender"
    : !payMethod ? "Elegí cómo pagó"
    : `Confirmar venta · ${money(total)} · ${PAY_LABELS[payMethod]}`;
}
$("#cartItems").addEventListener("click", e => {
  const b = e.target.closest("[data-cart]"); if (!b) return;
  const code = b.closest("li").dataset.code;
  const q = cart.get(code) || 0;
  if (b.dataset.cart === "inc") cart.set(code, q + 1);
  else if (b.dataset.cart === "dec") q > 1 ? cart.set(code, q - 1) : cart.delete(code);
  else cart.delete(code);
  renderCart();
});
$("#cartClear").addEventListener("click", () => { cart.clear(); payMethod = null; renderCart(); scanInput.focus(); });
document.querySelectorAll("[data-pay]").forEach(b => b.addEventListener("click", () => {
  payMethod = b.dataset.pay; renderCart(); $("#cartConfirm").focus();
}));
$("#cartConfirm").addEventListener("click", confirmSale);
setMode("sell");
renderCart();

function confirmSale(){
  const lines = cartLines();
  if (!lines.length) return;
  if (!payMethod) { toast("Elegí si pagó en efectivo, transferencia o tarjeta."); return; }
  if (!store || !me) return;
  const now = Date.now();
  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  const items = lines.map(({stock, ...l}) => l);
  const batch = fs.batch();
  lines.forEach(l => {
    batch.update(fs.collection("products").doc(docId(l.code)), {qty: increment(-l.qty), updatedAt: now});
    batch.set(fs.collection("moves").doc(), {
      code: l.code, name: l.name, delta: -l.qty, type: "out", qtyAfter: l.stock - l.qty,
      ts: now, source: "venta", by: me.email, byName: me.name
    });
  });
  batch.set(fs.collection("sales").doc(), {
    amount: total, method: payMethod, kind: "venta", items,
    note: lines.map(l => `${l.qty}× ${l.name}`).join(", ").slice(0, 200),
    day: localDayKey(), ts: now, by: me.email, byName: me.name
  });
  // Se aplica al instante en pantalla; Firestore lo sube (o lo guarda si no hay internet).
  batch.commit().catch(e => {
    reportError("venta", e.code || e.message);
    toast("No se pudo guardar la venta (" + (e.code || "error") + "). Revisá la conexión.");
  });
  const method = PAY_LABELS[payMethod];
  cart.clear(); payMethod = null; renderCart();
  lines.forEach(l => highlight(l.code));
  beep(1046);
  toast(`Venta registrada: ${money(total)} · ${method}`);
  scanInput.focus();
}

let audio = null;
function beep(freq){
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; o.type = "square";
    g.gain.setValueAtTime(0.06, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12);
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.13);
  } catch(e){}
}

/* ---------- tabla ---------- */
$("#rows").addEventListener("click", e => {
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const code = btn.closest("tr").dataset.code;
  const act = btn.dataset.act;
  if (act === "inc") changeStock(code, 1, "manual");
  else if (act === "dec") changeStock(code, -1, "manual");
  else if (act === "edit") openProduct(code);
  else if (act === "label") openLabel(code);
});
document.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => {
  const k = th.dataset.sort;
  sort = sort.key === k ? {key:k, dir:-sort.dir} : {key:k, dir: (k === "name" || k === "code") ? 1 : -1};
  render();
}));
["#search","#catFilter","#stockFilter"].forEach(s => $(s).addEventListener("input", render));

/* ---------- alta / edición ---------- */
const dlgP = $("#dlgProduct");
function openProduct(code, newCode, newName){
  editing = code || null;
  const p = code ? products.get(code) : null;
  $("#dlgProductTitle").textContent = p ? "Editar producto" : "Nuevo producto";
  $("#fName").value = p ? p.name : (newName || "");
  $("#nameHint").hidden = true;
  $("#fCode").value = p ? p.code : (newCode || "");
  $("#fPrice").value = p ? p.price : "";
  $("#fQty").value = p ? p.qty : (newCode && mode === "in" ? Math.max(1, parseInt($("#scanQty").value,10)||1) : 0);
  $("#fMin").value = p ? (p.min ?? 5) : 5;
  fillCategorySelect(p ? (p.cat || "") : "");
  $("#formErr").hidden = true;
  const del = $("#btnDelete"); del.hidden = !p; del.classList.remove("armed"); del.textContent = "Eliminar";
  dlgP.showModal();
  setTimeout(() => (newName ? $("#fPrice") : $("#fName")).focus(), 30);
  if (!p && newCode) lookupName(newCode);
}

// Busca el nombre del producto en bases públicas y gratuitas de códigos de barras.
// Ninguna cubre todos los artículos de librería: si no aparece, se escribe una vez
// y queda guardado para siempre en todos los dispositivos.
async function getJSON(url, ms = 6000){
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, {signal:ctrl.signal}); return r.ok ? await r.json() : null; }
  catch(e){ return null; }
  finally { clearTimeout(t); }
}
const offName = d => {
  if (!d || d.status !== 1 || !d.product) return "";
  const pr = d.product;
  return [pr.product_name_es || pr.product_name, pr.brands && pr.brands.split(",")[0], pr.quantity].filter(Boolean).join(" ").trim();
};
const NAME_SOURCES = [
  // Libros: los ISBN empiezan con 978 o 979.
  {label:"Open Library", isbn:true, find: async c => {
    const d = await getJSON(`https://openlibrary.org/api/books?bibkeys=ISBN:${c}&format=json&jscmd=data`);
    const b = d && d["ISBN:" + c];
    return b ? [b.title, b.authors && b.authors[0] && "– " + b.authors[0].name].filter(Boolean).join(" ") : "";
  }},
  {label:"Open Products Facts", find: async c => offName(await getJSON(`https://world.openproductsfacts.org/api/v2/product/${c}.json?fields=product_name,product_name_es,brands,quantity`))},
  {label:"Open Food Facts", find: async c => offName(await getJSON(`https://world.openfoodfacts.org/api/v2/product/${c}.json?fields=product_name,product_name_es,brands,quantity`))}
];
let lookupSeq = 0;
async function lookupName(code){
  if (!/^\d{8,14}$/.test(code) || /^2\d/.test(code)) return;   // los códigos internos (20…) no están en ninguna base
  const seq = ++lookupSeq, hint = $("#nameHint");
  hint.hidden = false; hint.textContent = "Buscando el nombre del producto…";
  const isbn = /^97[89]\d{10}$/.test(code);
  const sources = NAME_SOURCES.filter(s => !s.isbn || isbn);
  // Todas a la vez; gana la primera de la lista que tenga el producto.
  const results = await Promise.all(sources.map(s => s.find(code).catch(() => "")));
  const i = results.findIndex(Boolean);
  const name = i >= 0 ? results[i] : "";
  if (seq !== lookupSeq || !dlgP.open || $("#fCode").value.trim() !== code) return;
  if (name && !$("#fName").value.trim()) {
    $("#fName").value = name;
    hint.textContent = `Nombre encontrado en ${sources[i].label}. Revisalo y corregilo si hace falta.`;
    $("#fPrice").focus();
  } else if (!name) {
    hint.textContent = "Este código no está en las bases públicas. Escribí el nombre una sola vez: queda guardado y la próxima vez que lo escanees aparece solo.";
    if (!$("#fName").value.trim()) $("#fName").focus();
  } else hint.hidden = true;
}
function generateCode(){
  for (let i = 0; i < 50; i++) {
    const body = "20" + String(Date.now() % 1e6).padStart(6,"0") + String(Math.floor(Math.random()*1e4)).padStart(4,"0");
    const code = body + ean13Check(body);
    if (!products.has(code)) return code;
  }
  return null;
}
$("#btnGen").addEventListener("click", () => {
  const c = generateCode();
  if (c) { $("#fCode").value = c; toast("Código EAN‑13 generado: " + c); }
});
$("#productForm").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#formErr");
  const name = $("#fName").value.trim();
  let code = $("#fCode").value.trim();
  const price = parseFloat($("#fPrice").value);
  const qty = parseInt($("#fQty").value, 10);
  const min = parseInt($("#fMin").value, 10);
  const show = m => { err.textContent = m; err.hidden = false; };
  if (!name) return show("Escribí el nombre del producto.");
  if (!code) { code = generateCode(); if (!code) return show("No se pudo generar un código. Probá de nuevo."); $("#fCode").value = code; }
  if (!/^[\x20-\x7E]+$/.test(code)) return show("El código solo puede tener letras, números y símbolos comunes (sin acentos ni ñ).");
  if (code !== editing && products.has(code)) return show("Ese código ya pertenece a “" + products.get(code).name + "”.");
  if (isNaN(price) || price < 0) return show("Poné un precio válido (0 o más).");
  const prev = editing ? products.get(editing) : null;
  const p = {
    code, name, price: Math.round(price*100)/100,
    qty: isNaN(qty) ? 0 : qty, min: isNaN(min) ? 0 : min,
    cat: $("#fCat").value.trim(),
    createdAt: prev ? (prev.createdAt || Date.now()) : Date.now(),
    updatedAt: Date.now()
  };
  $("#btnSave").disabled = true;
  const ok = await guard(async () => {
    await store.save(p);
    if (editing && editing !== code) await store.remove(editing);
    const before = prev ? (Number(prev.qty)||0) : 0;
    if (!prev && p.qty) await store.log({code, name, delta:p.qty, type:"in", qtyAfter:p.qty, ts:Date.now(), source:"alta"});
    else if (prev && before !== p.qty) await store.log({code, name, delta:p.qty - before, type:"set", qtyAfter:p.qty, ts:Date.now(), source:"ajuste"});
  });
  $("#btnSave").disabled = false;
  if (ok) {
    dlgP.close();
    toast(prev ? "Producto actualizado" : "Producto agregado");
    highlight(code);
    if (!prev && mode === "sell") addToCart(code, 1);   // se escaneó para vender: va directo al ticket
    else if (!prev) showAdded(p);
    if (!prev && isGenerated(code)) setTimeout(() => openLabel(code), 150);
  }
});
const isGenerated = c => isEAN13(c) && /^2\d/.test(c);
$("#btnDelete").addEventListener("click", async () => {
  const b = $("#btnDelete");
  if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmar eliminación"; return; }
  const name = products.get(editing)?.name;
  const ok = await guard(() => store.remove(editing));
  if (ok) { dlgP.close(); toast("Eliminado: " + name); }
});
document.querySelectorAll("dialog [data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));
document.querySelectorAll("dialog").forEach(d => d.addEventListener("close", () => setTimeout(() => scanInput.focus(), 20)));

/* ---------- etiquetas ---------- */
const dlgL = $("#dlgLabel");
function openLabel(code){
  labelProduct = products.get(code); if (!labelProduct) return;
  drawLabel();
  dlgL.showModal();
}
function drawLabel(){
  const p = labelProduct, c = $("#labelCanvas"), ctx = c.getContext("2d");
  const showName = $("#optName").checked, showPrice = $("#optPrice").checked;
  // código de barras en un canvas aparte, a escala nítida para impresión
  const bc = document.createElement("canvas");
  const fmt = isEAN13(p.code) ? "EAN13" : "CODE128";
  try {
    JsBarcode(bc, p.code, {format:fmt, width:3, height:130, margin:0, fontSize:26, textMargin:6, font:"monospace", background:"#FFFFFF", lineColor:"#000000", flat: fmt !== "EAN13"});
  } catch(e) {
    JsBarcode(bc, p.code, {format:"CODE128", width:3, height:130, margin:0, fontSize:26, textMargin:6, font:"monospace"});
  }
  const pad = 36, top = showName || showPrice ? 92 : 30;
  c.width = Math.max(bc.width + pad*2, 520);
  c.height = top + bc.height + 32;
  ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0,0,c.width,c.height);
  ctx.fillStyle = "#000000"; ctx.textBaseline = "alphabetic";
  if (showName) {
    ctx.font = "600 30px 'Barlow Semi Condensed', Arial, sans-serif"; ctx.textAlign = "left";
    let n = p.name; const maxW = c.width - pad*2 - (showPrice ? 200 : 0);
    while (ctx.measureText(n).width > maxW && n.length > 4) n = n.slice(0,-2);
    if (n !== p.name) n = n.trimEnd() + "…";
    ctx.fillText(n, pad, 56);
  }
  if (showPrice) {
    ctx.font = "700 40px 'Barlow Semi Condensed', Arial, sans-serif"; ctx.textAlign = showName ? "right" : "left";
    ctx.fillText(money(p.price), showName ? c.width - pad : pad, 60);
  }
  ctx.drawImage(bc, Math.round((c.width - bc.width)/2), top);
  $("#labelHint").textContent = (fmt === "EAN13" ? "Formato EAN‑13. " : "Formato Code 128. ") + "Imprimila a 100% de escala (sin “ajustar a página”) para que el escáner la lea bien.";
}
["#optName","#optPrice"].forEach(s => $(s).addEventListener("change", drawLabel));
$("#btnCopyCode").addEventListener("click", () => {
  const code = labelProduct?.code || "";
  navigator.clipboard?.writeText(code).then(() => toast("Código copiado"), () => toast("Código: " + code));
});
function saveFile(filename, blob){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$("#btnDownloadLabel").addEventListener("click", () => {
  const p = labelProduct; if (!p) return;
  $("#labelCanvas").toBlob(b => saveFile("etiqueta-" + p.code.replace(/[^A-Za-z0-9_-]/g,"") + ".png", b), "image/png");
});

/* ---------- respaldo ---------- */
$("#btnExport").addEventListener("click", () => {
  const data = {app:"deposito-stock", exportedAt:new Date().toISOString(), products:[...products.values()]};
  const d = new Date().toISOString().slice(0,10);
  saveFile("stock-" + d + ".json", new Blob([JSON.stringify(data,null,2)], {type:"application/json"}));
});
$("#importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const list = (data.products || []).filter(p => p && p.code && p.name);
    if (!list.length) return toast("El archivo no tiene productos válidos.");
    const ok = await guard(async () => { for (const p of list) await store.save({...p, code:String(p.code), updatedAt:Date.now()}); });
    if (ok) toast("Importados " + list.length + " productos");
  } catch(err){ toast("No se pudo leer el archivo. Tiene que ser un respaldo .json de esta app."); }
});

/* ---------- ejemplos ---------- */
$("#btnSample").addEventListener("click", async () => {
  const mk = (name, price, qty, min, cat, brand) => ({name:"[Ejemplo] " + name, price, qty, min, cat, brand, code: generateCode(), createdAt:Date.now(), updatedAt:Date.now()});
  const list = [
    mk("Cuaderno A4 rayado 48 hojas", 6500, 20, 5, "Cuadernos A4", "Rivadavia"),
    mk("Lápices de colores x12 largos", 5800, 3, 4, "Lápices de colores", "Faber-Castell"),
    mk("Lápiz negro HB", 650, 60, 15, "Lápices negros", "Staedtler"),
    mk("Crema corporal Tododia 400 ml", 18900, 0, 2, "Cremas corporales", "Natura"),
    mk("Perfume femenino 50 ml", 24500, 4, 2, "Perfumes y colonias", "Avon")
  ];
  const ok = await guard(async () => { for (const p of list) await store.save(p); });
  if (ok) toast("Cargados 5 productos de ejemplo. Podés editarlos o borrarlos.");
});

$("#btnNew").addEventListener("click", () => openProduct(null));
$("#btnManual").addEventListener("click", () => {
  const v = scanInput.value.trim(); scanInput.value = ""; hideSug();
  if (v && looksLikeCode(v)) openProduct(null, v); else openProduct(null, "", v);
});
// Si se escanea dentro del campo "Código" del alta, buscar el nombre automáticamente.
$("#fCode").addEventListener("change", () => { if (!editing && !$("#fName").value.trim()) lookupName($("#fCode").value.trim()); });
// El escáner manda Enter al final: en el campo "Código" no tiene que guardar el formulario.
$("#fCode").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (!editing && !$("#fName").value.trim()) lookupName($("#fCode").value.trim());
  ($("#fName").value.trim() ? $("#fPrice") : $("#fName")).focus();
});
/* ---------- login ---------- */
const loginErrors = {
  "auth/popup-closed-by-user":"",
  "auth/cancelled-popup-request":"",
  "auth/network-request-failed":"Sin conexión a internet.",
  "auth/unauthorized-domain":"Este sitio todavía no está autorizado en Firebase (Authentication → Configuración → Dominios autorizados).",
  "auth/operation-not-allowed":"El ingreso con Google no está activado en Firebase (Authentication → Método de acceso → Google).",
  "auth/user-disabled":"Esta cuenta está deshabilitada."
};
const google = new firebase.auth.GoogleAuthProvider();
google.setCustomParameters({prompt:"select_account"});
$("#btnGoogle").addEventListener("click", async () => {
  const err = $("#loginErr"), btn = $("#btnGoogle");
  err.hidden = true; btn.disabled = true;
  try { await auth.signInWithPopup(google); }
  catch(ex){
    // Algunos celulares bloquean la ventana emergente: usar redirección.
    if (ex.code === "auth/popup-blocked" || ex.code === "auth/operation-not-supported-in-this-environment") {
      return auth.signInWithRedirect(google);
    }
    const msg = ex.code in loginErrors ? loginErrors[ex.code] : "No se pudo ingresar (" + ex.code + ").";
    if (msg) { err.textContent = msg; err.hidden = false; }
  }
  btn.disabled = false;
});
auth.getRedirectResult().catch(ex => {
  const msg = loginErrors[ex.code] ?? "No se pudo ingresar (" + ex.code + ").";
  if (msg) { $("#loginErr").textContent = msg; $("#loginErr").hidden = false; }
});
$("#btnLogout").addEventListener("click", () => auth.signOut());
$("#btnDeniedOut").addEventListener("click", () => auth.signOut());
$("#btnDeniedRetry").addEventListener("click", () => auth.currentUser && onSignedIn(auth.currentUser));
auth.onAuthStateChanged(u => u ? onSignedIn(u) : stopApp());

// Lo que necesita el panel admin (admin.js).
window.Stock = {
  fs, auth, esc, money, int, toast, timeAgo, deviceName,
  get me(){ return me; },
  get products(){ return products; },
  showView, changeStock, saveFile, docId
};
})();
