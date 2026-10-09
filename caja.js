// Caja: ventas del día, deudas (fiado) y cuentas mensuales con resumen tipo factura.
(function(){
"use strict";
const $ = s => document.querySelector(s);
const S = () => window.Stock;
const FV = () => firebase.firestore.FieldValue;

/* ---------- utilidades ---------- */
const pad = n => String(n).padStart(2, "0");
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
const monthName = m => {
  const [y, mo] = m.split("-");
  const s = new Date(+y, +mo - 1, 1).toLocaleDateString("es-AR", {month:"long", year:"numeric"});
  return s[0].toUpperCase() + s.slice(1);
};
const fmtDay = k => { const [, m, d] = k.split("-"); return `${d}/${m}`; };
const fmtDate = ts => new Date(ts).toLocaleDateString("es-AR", {day:"2-digit", month:"2-digit"});
const fmtFull = ts => new Date(ts).toLocaleDateString("es-AR", {day:"2-digit", month:"2-digit", year:"numeric"});
const hhmm = ts => new Date(ts).toLocaleTimeString("es-AR", {hour:"2-digit", minute:"2-digit"});
const round2 = n => Math.round(n * 100) / 100;
const parseMoney = v => { const n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? round2(n) : NaN; };
const METHODS = {efectivo:"Efectivo", transferencia:"Transferencia / MP", tarjeta:"Tarjeta"};
const KINDS = {venta:"Venta", "cobro-deuda":"Cobro de deuda", cuenta:"Cuenta mensual"};
const methodOptions = () => Object.entries(METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
const who = () => ({by: S().me.email, byName: S().me.name});
const rem = d => Math.max(0, round2((+d.amount || 0) - (+d.paidAmount || 0)));

// Las escrituras no se esperan: con la caché offline la pantalla se actualiza al instante
// y Firestore sincroniza cuando hay conexión.
function fire(p){
  return p.catch(e => S().toast(e && e.code === "permission-denied"
    ? "Tu cuenta no tiene permiso para guardar."
    : "No se pudo guardar (" + ((e && e.code) || "error") + ")."));
}
// Botón de dos pasos para acciones que borran algo.
function confirmTwice(btn, label){
  if (btn.classList.contains("armed")) return true;
  const old = btn.textContent;
  btn.classList.add("armed"); btn.textContent = label || "¿Seguro?";
  setTimeout(() => { btn.classList.remove("armed"); btn.textContent = old; }, 4000);
  return false;
}

/* ---------- estado y suscripciones ---------- */
let unsubs = [], daySub = null, monthSubs = [];
let day = dayKey(), month = monthKey();
let sales = [], pending = [], paidDebts = [], accounts = [], entries = [], months = [];
let business = {};
let debtTab = "pending", payingId = null, settlingId = null;

const onErr = what => e => console.warn("Caja:", what, e.code);

function start(){
  stop();
  const {fs} = S();
  day = dayKey(); month = monthKey();
  $("#cDay").value = day; $("#cMonth").value = month;
  unsubs.push(fs.doc("config/business").onSnapshot(d => { business = (d.exists && d.data()) || {}; }, onErr("comercio")));
  unsubs.push(fs.collection("debts").where("paid", "==", false).onSnapshot(s => {
    pending = s.docs.map(d => ({id:d.id, ...d.data()})); renderDebts(); renderTotals();
  }, onErr("deudas")));
  unsubs.push(fs.collection("debts").orderBy("paidAt", "desc").limit(50).onSnapshot(s => {
    paidDebts = s.docs.map(d => ({id:d.id, ...d.data()})); renderDebts();
  }, onErr("deudas pagadas")));
  unsubs.push(fs.collection("accounts").onSnapshot(s => {
    accounts = s.docs.map(d => ({id:d.id, ...d.data()})); renderAccounts();
  }, onErr("cuentas")));
  subDay(); subMonth();
}
function stop(){
  unsubs.splice(0).forEach(u => u());
  if (daySub) daySub(); daySub = null;
  monthSubs.splice(0).forEach(u => u());
}
function subDay(){
  if (daySub) daySub();
  sales = []; renderSales(); renderTotals();
  daySub = S().fs.collection("sales").where("day", "==", day).onSnapshot(s => {
    sales = s.docs.map(d => ({id:d.id, ...d.data()})).sort((a, b) => b.ts - a.ts);
    renderSales(); renderTotals();
  }, onErr("ventas"));
}
function subMonth(){
  monthSubs.splice(0).forEach(u => u());
  entries = []; months = []; renderAccounts();
  const {fs} = S();
  monthSubs.push(fs.collection("accountEntries").where("month", "==", month).onSnapshot(s => {
    entries = s.docs.map(d => ({id:d.id, ...d.data()})).sort((a, b) => a.ts - b.ts); renderAccounts();
  }, onErr("retiros")));
  monthSubs.push(fs.collection("accountMonths").where("month", "==", month).onSnapshot(s => {
    months = s.docs.map(d => ({id:d.id, ...d.data()})); renderAccounts();
  }, onErr("cierres")));
}

$("#cDay").addEventListener("change", () => { if ($("#cDay").value) { day = $("#cDay").value; subDay(); } });
$("#cToday").addEventListener("click", () => { day = dayKey(); $("#cDay").value = day; subDay(); });
$("#cMonth").addEventListener("change", () => { if ($("#cMonth").value) { month = $("#cMonth").value; settlingId = null; subMonth(); } });

/* ---------- totales ---------- */
function renderTotals(){
  const {money} = S();
  const sum = f => round2(sales.filter(f).reduce((a, s) => a + (+s.amount || 0), 0));
  $("#cTotalLabel").textContent = day === dayKey() ? "Total de hoy" : "Total del " + fmtDay(day);
  $("#cTotal").textContent = money(sum(() => true));
  $("#cCash").textContent = money(sum(s => s.method === "efectivo"));
  $("#cTransfer").textContent = money(sum(s => s.method === "transferencia"));
  $("#cCard").textContent = money(sum(s => s.method === "tarjeta"));
  $("#cOwed").textContent = money(round2(pending.reduce((a, d) => a + rem(d), 0)));
  const people = new Set(pending.map(d => d.name.trim().toLowerCase())).size;
  $("#cOwedN").textContent = people ? `${people} persona${people > 1 ? "s" : ""}` : "nadie debe";
}

/* ---------- ventas del día ---------- */
function renderSales(){
  const {esc, money} = S();
  const el = $("#salesList");
  if (!sales.length) {
    el.innerHTML = `<li class="empty">No hay ventas cargadas ${day === dayKey() ? "hoy" : "el " + fmtDay(day)}.</li>`;
    return;
  }
  el.innerHTML = sales.map(s => `<li data-id="${esc(s.id)}">
    <div class="row"><span><span class="meta">${hhmm(s.ts)}</span> ${s.items ? "Venta" + (s.items.length > 1 ? ` (${s.items.length} productos)` : "") : esc(s.note || KINDS[s.kind] || "Venta")}</span><b class="num">${money(s.amount)}</b></div>
    ${s.items ? `<ul class="sale-items">${s.items.map(i => `<li><span>${i.qty} × ${esc(i.name)}</span><span class="num">${money(i.amount)}</span></li>`).join("")}</ul>` : ""}
    <div class="row"><span class="meta">${METHODS[s.method] || esc(s.method)}${s.kind && s.kind !== "venta" ? " · " + KINDS[s.kind] : ""} · ${esc(s.byName || s.by || "")}</span>
      ${s.kind === "venta" || !s.kind || S().me.isAdmin ? '<button class="link-btn" type="button" data-act="del-sale">Borrar</button>' : ""}</div>
  </li>`).join("");
}
$("#saleForm").addEventListener("submit", e => {
  e.preventDefault();
  const amount = parseMoney($("#sAmount").value);
  if (!(amount > 0)) { S().toast("Escribí el monto de la venta."); $("#sAmount").focus(); return; }
  fire(S().fs.collection("sales").doc().set({
    amount, method: $("#sMethod").value, note: $("#sNote").value.trim(),
    kind: "venta", day, ts: Date.now(), ...who()
  }));
  $("#sAmount").value = ""; $("#sNote").value = ""; $("#sAmount").focus();
});
$("#salesList").addEventListener("click", async e => {
  const b = e.target.closest("[data-act='del-sale']"); if (!b) return;
  const s = sales.find(x => x.id === b.closest("li").dataset.id); if (!s) return;
  if (!confirmTwice(b, s.kind && s.kind !== "venta" ? "¿Borrar y deshacer el cobro?" : "¿Borrar?")) return;
  try { await undoSale(s.id, s); S().toast(s.kind === "cobro-deuda" ? "Cobro borrado. La deuda vuelve a figurar como pendiente." : s.kind === "cuenta" ? "Cobro borrado. La cuenta vuelve a figurar sin pagar." : s.items ? "Venta borrada. Los productos volvieron al stock." : "Venta borrada"); }
  catch(ex){ S().toast("No se pudo borrar (" + (ex.code || "error") + ")."); }
});

// Borra una venta o cobro y deshace lo que ese cobro había marcado:
// un cobro de deuda vuelve a dejar la deuda pendiente; el pago de una cuenta mensual la deja sin pagar.
async function undoSale(id, s){
  const {fs} = S();
  const batch = fs.batch();
  batch.delete(fs.doc("sales/" + id));
  // Venta con productos: vuelven al stock.
  (s.items || []).forEach(i => {
    if (!S().products.has(i.code)) return;
    batch.update(fs.collection("products").doc(S().docId(i.code)), {qty: FV().increment(+i.qty || 0), updatedAt: Date.now()});
    batch.set(fs.collection("moves").doc(), {
      code: i.code, name: i.name, delta: +i.qty || 0, type: "in",
      qtyAfter: (Number(S().products.get(i.code).qty) || 0) + (+i.qty || 0),
      ts: Date.now(), source: "anulación", ...who()
    });
  });
  if (s.kind === "cobro-deuda" && s.debtId) {
    const d = await fs.doc("debts/" + s.debtId).get();
    if (d.exists) {
      const pay = (d.data().payments || []).find(p => p.saleId === id);
      const upd = {paid: false, paidAt: FV().delete(), paidBy: FV().delete(), paidAmount: FV().increment(-(+s.amount || 0))};
      if (pay) upd.payments = FV().arrayRemove(pay);
      batch.update(d.ref, upd);
    }
  }
  if (s.kind === "cuenta") {
    const m = await fs.collection("accountMonths").where("saleId", "==", id).get();
    m.docs.forEach(doc => batch.delete(doc.ref));
  }
  await batch.commit();
}

/* ---------- deudas (fiado) ---------- */
function renderDebts(){
  const {esc, money} = S();
  const el = $("#debtList");
  $("#debtNames").innerHTML = [...new Set([...pending, ...paidDebts].map(d => d.name))]
    .map(n => `<option value="${esc(n)}">`).join("");
  document.querySelectorAll("[data-debts]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.debts === debtTab)));

  if (debtTab === "paid") {
    el.innerHTML = paidDebts.length ? paidDebts.map(d => `<li>
      <div class="row"><b>${esc(d.name)}</b><span class="num">${money(d.amount)}</span></div>
      <div class="meta">${esc(d.note || "Sin detalle")} · anotada el ${fmtDate(d.ts)} · pagó el ${fmtDate(d.paidAt)}</div>
    </li>`).join("") : '<li class="empty">Todavía nadie terminó de pagar.</li>';
    return;
  }
  if (!pending.length) { el.innerHTML = '<li class="empty">Nadie debe nada.</li>'; return; }

  const groups = new Map();
  pending.forEach(d => {
    const k = d.name.trim().toLowerCase();
    if (!groups.has(k)) groups.set(k, {name: d.name.trim(), items: []});
    groups.get(k).items.push(d);
  });
  el.innerHTML = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, "es")).map(g => {
    g.items.sort((a, b) => a.ts - b.ts);
    const total = round2(g.items.reduce((a, d) => a + rem(d), 0));
    return `<li class="debt-group" data-name="${esc(g.name)}">
      <div class="row"><b>${esc(g.name)}</b><span class="row-actions"><b class="num owed">${money(total)}</b><button class="btn sm" type="button" data-act="debt-invoice">Comprobante</button></span></div>
      ${g.items.map(d => payingId === d.id ? `
        <form class="sub pay-form" data-id="${esc(d.id)}">
          <span class="meta">Cobrar a ${esc(g.name)} · ${esc(d.note || "Sin detalle")}</span>
          <span class="pay-inputs">
            <input name="amt" type="number" step="0.01" min="0" value="${rem(d)}" aria-label="Monto que paga">
            <select name="method" aria-label="Medio de pago">${methodOptions()}</select>
            <button class="btn sm primary" type="submit">Confirmar</button>
            <button class="btn sm" type="button" data-act="pay-cancel">Cancelar</button>
          </span>
        </form>` : `
        <div class="row sub" data-id="${esc(d.id)}">
          <span class="meta">${fmtDate(d.ts)} · ${esc(d.note || "Sin detalle")}${d.paidAmount ? ` · pagó ${money(d.paidAmount)} de ${money(d.amount)}` : ""}</span>
          <span class="row-actions"><span class="num">${money(rem(d))}</span>
            <button class="btn sm primary" type="button" data-act="pay">Cobrar</button>
            <button class="link-btn" type="button" data-act="del-debt">Borrar</button></span>
        </div>`).join("")}
    </li>`;
  }).join("");
  const amt = el.querySelector(".pay-form input[name='amt']");
  if (amt && document.activeElement === document.body) amt.focus();
}
document.querySelectorAll("[data-debts]").forEach(b => b.addEventListener("click", () => {
  debtTab = b.dataset.debts; payingId = null; renderDebts();
}));
$("#debtForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("#dName").value.trim(), amount = parseMoney($("#dAmount").value);
  if (!name) { S().toast("Escribí el nombre de la persona."); $("#dName").focus(); return; }
  if (!(amount > 0)) { S().toast("Escribí cuánto debe."); $("#dAmount").focus(); return; }
  // Si ya debía algo, usar el nombre tal como está escrito para que se agrupe.
  const known = pending.find(d => d.name.trim().toLowerCase() === name.toLowerCase());
  fire(S().fs.collection("debts").doc().set({
    name: known ? known.name.trim() : name, amount, note: $("#dNote").value.trim(),
    paid: false, paidAmount: 0, payments: [], ts: Date.now(), day: dayKey(), ...who()
  }));
  $("#dName").value = ""; $("#dAmount").value = ""; $("#dNote").value = ""; $("#dName").focus();
  S().toast("Deuda anotada");
});
$("#debtList").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act;
  const id = b.closest("[data-id]")?.dataset.id;
  if (act === "pay") { payingId = id; renderDebts(); }
  else if (act === "pay-cancel") { payingId = null; renderDebts(); }
  else if (act === "del-debt") { if (confirmTwice(b, "¿Borrar?")) fire(S().fs.doc("debts/" + id).delete()); }
  else if (act === "debt-invoice") debtInvoice(b.closest(".debt-group").dataset.name);
});
$("#debtList").addEventListener("submit", e => {
  const f = e.target.closest(".pay-form"); if (!f) return;
  e.preventDefault();
  const d = pending.find(x => x.id === f.dataset.id); if (!d) return;
  const amount = parseMoney(f.amt.value);
  if (!(amount > 0)) { S().toast("Escribí cuánto paga."); return; }
  const paidNow = Math.min(amount, rem(d));
  const full = paidNow >= rem(d) - 0.004;
  const {fs} = S();
  const batch = fs.batch();
  const saleRef = fs.collection("sales").doc();
  // El cobro entra en la caja del día en que se cobra.
  batch.set(saleRef, {
    amount: paidNow, method: f.method.value, kind: "cobro-deuda", debtId: d.id,
    note: "Cobro de deuda: " + d.name + (d.note ? " (" + d.note + ")" : ""),
    day: dayKey(), ts: Date.now(), ...who()
  });
  const upd = {
    paidAmount: FV().increment(paidNow),
    payments: FV().arrayUnion({ts: Date.now(), amount: paidNow, method: f.method.value, by: S().me.email, saleId: saleRef.id})
  };
  if (full) Object.assign(upd, {paid: true, paidAt: Date.now(), paidBy: S().me.email});
  batch.update(fs.doc("debts/" + d.id), upd);
  fire(batch.commit());
  payingId = null; renderDebts();
  S().toast(full ? `${d.name} terminó de pagar esa deuda` : `Pago parcial registrado: ${S().money(paidNow)}`);
});

/* ---------- cuentas mensuales ---------- */
function findProduct(text){
  const t = String(text || "").trim().toLowerCase(); if (!t) return null;
  for (const p of S().products.values()) if (p.code.toLowerCase() === t || p.name.toLowerCase() === t) return p;
  return null;
}
function renderAccounts(){
  const {esc, money} = S();
  $("#productNames").innerHTML = [...S().products.values()]
    .map(p => `<option value="${esc(p.name)}">${esc(money(p.price))}</option>`).join("");
  const grid = $("#accGrid");

  // Guardar lo que se está escribiendo para no perderlo al redibujar.
  const drafts = {};
  grid.querySelectorAll(".entry-form").forEach(f => {
    drafts[f.dataset.acc] = {item: f.item.value, qty: f.qty.value, price: f.price.value,
      focus: f.contains(document.activeElement) ? document.activeElement.name : null};
  });

  if (!accounts.length) {
    grid.innerHTML = '<p class="empty-note">Todavía no hay cuentas. Creá una con el nombre del colegio o de la persona.</p>';
    return;
  }
  grid.innerHTML = accounts.slice().sort((a, b) => a.name.localeCompare(b.name, "es")).map(a => {
    const es = entries.filter(e => e.accountId === a.id);
    const total = round2(es.reduce((s, e) => s + (+e.amount || 0), 0));
    const st = months.find(m => m.accountId === a.id);
    return `<article class="acc-card${st ? " settled" : ""}" data-acc="${esc(a.id)}">
      <header>
        <div><h3>${esc(a.name)}</h3><span class="tag">${a.type === "colegio" ? "Colegio" : "Particular"}</span></div>
        <div class="acc-total"><span class="label">${monthName(month)}</span><b class="num">${money(total)}</b></div>
      </header>
      ${st ? `<div class="paid-banner">Pagado el ${fmtDate(st.settledAt)} · ${METHODS[st.method] || ""} <button class="link-btn" type="button" data-act="unsettle">Deshacer</button></div>` : ""}
      <div class="table-wrap"><table class="inv-table"><tbody>
        ${es.map(e => `<tr data-id="${esc(e.id)}">
          <td class="t">${fmtDate(e.ts)}</td>
          <td>${esc(e.desc)}</td>
          <td class="r num t">${e.qty} × ${money(e.unitPrice)}</td>
          <td class="r num">${money(e.amount)}</td>
          <td class="r">${st ? "" : '<button class="link-btn" type="button" data-act="del-entry" aria-label="Borrar retiro">✕</button>'}</td>
        </tr>`).join("") || '<tr><td colspan="5" class="meta">Sin retiros este mes.</td></tr>'}
      </tbody></table></div>
      ${st ? "" : `<form class="entry-form" data-acc="${esc(a.id)}" novalidate>
        <input name="item" class="grow" list="productNames" placeholder="Producto (buscá o escaneá) o detalle" autocomplete="off" aria-label="Producto o detalle">
        <input name="qty" type="number" min="1" step="1" value="1" aria-label="Cantidad">
        <input name="price" type="number" min="0" step="0.01" placeholder="Precio c/u" aria-label="Precio unitario">
        <button class="btn sm primary" type="submit">Agregar</button>
      </form>`}
      <footer>
        <button class="btn sm primary" type="button" data-act="invoice" ${es.length ? "" : "disabled"}>Ver resumen / factura</button>
        ${st ? "" : settlingId === a.id ? `
          <span class="pay-inputs"><select name="method" aria-label="Medio de pago">${methodOptions()}</select>
          <button class="btn sm" type="button" data-act="settle-ok">Confirmar pago de ${money(total)}</button>
          <button class="link-btn" type="button" data-act="settle-cancel">Cancelar</button></span>`
        : `<button class="btn sm" type="button" data-act="settle" ${es.length ? "" : "disabled"}>Marcar como pagado</button>`}
        <button class="link-btn" type="button" data-act="del-acc">Eliminar cuenta</button>
      </footer>
    </article>`;
  }).join("");

  Object.entries(drafts).forEach(([id, d]) => {
    const f = grid.querySelector(`.entry-form[data-acc="${CSS.escape(id)}"]`); if (!f) return;
    f.item.value = d.item; f.qty.value = d.qty; f.price.value = d.price;
    if (d.focus) f[d.focus].focus();
  });
}
$("#accForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("#aName").value.trim();
  if (!name) { S().toast("Escribí el nombre de la cuenta."); return; }
  if (accounts.some(a => a.name.trim().toLowerCase() === name.toLowerCase())) { S().toast("Ya existe una cuenta con ese nombre."); return; }
  fire(S().fs.collection("accounts").doc().set({name, type: $("#aType").value, createdAt: Date.now(), ...who()}));
  $("#aName").value = "";
  S().toast("Cuenta creada: " + name);
});
// Al elegir o escanear un producto, completar el precio.
$("#accGrid").addEventListener("input", e => {
  if (e.target.name !== "item") return;
  const p = findProduct(e.target.value); if (!p) return;
  const f = e.target.form;
  f.item.value = p.name;
  f.price.value = p.price;
});
$("#accGrid").addEventListener("keydown", e => {
  // El escáner termina con Enter: si el código es un producto, completar en vez de agregar sin precio.
  if (e.key !== "Enter" || e.target.name !== "item") return;
  const f = e.target.form;
  if (!f.price.value) {
    e.preventDefault();
    const p = findProduct(e.target.value);
    if (p) { f.item.value = p.name; f.price.value = p.price; f.qty.focus(); f.qty.select(); }
    else f.price.focus();
  }
});
$("#accGrid").addEventListener("submit", e => {
  const f = e.target.closest(".entry-form"); if (!f) return;
  e.preventDefault();
  const a = accounts.find(x => x.id === f.dataset.acc); if (!a) return;
  const item = f.item.value.trim();
  const qty = Math.max(1, parseInt(f.qty.value, 10) || 1);
  const p = findProduct(item);
  let price = parseMoney(f.price.value);
  if (isNaN(price) && p) price = +p.price;
  if (!item) { S().toast("Escribí el producto o el detalle."); f.item.focus(); return; }
  if (isNaN(price) || price < 0) { S().toast("Poné el precio de " + item + "."); f.price.focus(); return; }
  fire(S().fs.collection("accountEntries").doc().set({
    accountId: a.id, accountName: a.name, month,
    desc: p ? p.name : item, code: p ? p.code : null,
    qty, unitPrice: price, amount: round2(price * qty), ts: Date.now(), ...who()
  }));
  // Lo que se lleva sale del stock.
  if (p) S().changeStock(p.code, -qty, "cuenta");
  f.item.value = ""; f.qty.value = 1; f.price.value = ""; f.item.focus();
});
$("#accGrid").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
  const card = b.closest(".acc-card"); if (!card) return;
  const a = accounts.find(x => x.id === card.dataset.acc); if (!a) return;
  const es = entries.filter(x => x.accountId === a.id);
  const total = round2(es.reduce((s, x) => s + (+x.amount || 0), 0));
  const st = months.find(m => m.accountId === a.id);
  const {fs} = S();
  switch (b.dataset.act) {
    case "invoice": accountInvoice(a, es, total, st); break;
    case "del-entry": {
      if (!confirmTwice(b, "¿Borrar?")) return;
      const en = es.find(x => x.id === b.closest("tr").dataset.id); if (!en) return;
      fire(fs.doc("accountEntries/" + en.id).delete());
      if (en.code && S().products.has(en.code)) S().changeStock(en.code, +en.qty, "cuenta");   // vuelve al stock
      break;
    }
    case "settle": settlingId = a.id; renderAccounts(); break;
    case "settle-cancel": settlingId = null; renderAccounts(); break;
    case "settle-ok": {
      const method = card.querySelector("select[name='method']").value;
      const batch = fs.batch();
      const saleRef = fs.collection("sales").doc();
      batch.set(saleRef, {
        amount: total, method, kind: "cuenta", note: `Cuenta mensual: ${a.name} (${monthName(month)})`,
        day: dayKey(), ts: Date.now(), ...who()
      });
      batch.set(fs.doc(`accountMonths/${a.id}_${month}`), {
        accountId: a.id, month, total, method, saleId: saleRef.id, settledAt: Date.now(), ...who()
      });
      fire(batch.commit());
      settlingId = null;
      S().toast(`${a.name}: ${monthName(month)} marcado como pagado`);
      break;
    }
    case "unsettle": {
      if (!st || !confirmTwice(b, "¿Deshacer el pago?")) return;
      const batch = fs.batch();
      batch.delete(fs.doc("accountMonths/" + st.id));
      if (st.saleId) batch.delete(fs.doc("sales/" + st.saleId));
      fire(batch.commit());
      break;
    }
    case "del-acc": {
      if (es.length && !st) { S().toast("Esta cuenta tiene retiros sin cobrar este mes. Cobrala o borrá los retiros primero."); return; }
      if (!confirmTwice(b, "¿Eliminar cuenta?")) return;
      fire(fs.doc("accounts/" + a.id).delete());
      break;
    }
  }
});

/* ---------- resumen tipo factura ---------- */
let invoice = null;   // {title, client, period, lines:[{date, desc, qty, unit, amount}], total, paid, file}
const logoImg = new Image();
logoImg.src = "logo.png";

function accountInvoice(a, es, total, st){
  openInvoice({
    title: "RESUMEN DE CUENTA",
    client: a.name, period: monthName(month),
    lines: es.map(e => ({date: fmtDate(e.ts), desc: e.desc, qty: e.qty, unit: e.unitPrice, amount: e.amount})),
    total, paid: st ? "PAGADO el " + fmtFull(st.settledAt) : null,
    file: `resumen-${a.name}-${month}`
  });
}
function debtInvoice(name){
  const items = pending.filter(d => d.name.trim().toLowerCase() === name.toLowerCase()).sort((a, b) => a.ts - b.ts);
  if (!items.length) return;
  const lines = items.map(d => ({
    date: fmtDate(d.ts),
    desc: (d.note || "Compra") + (d.paidAmount ? ` (pagó ${S().money(d.paidAmount)} de ${S().money(d.amount)})` : ""),
    qty: 1, unit: rem(d), amount: rem(d)
  }));
  openInvoice({
    title: "DETALLE DE DEUDA", client: name, period: "Al " + fmtFull(Date.now()),
    lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)), paid: null,
    file: `deuda-${name}-${dayKey()}`
  });
}

function openInvoice(inv){
  invoice = inv;
  drawInvoice(inv);
  $("#dlgInvoiceTitle").textContent = inv.title === "RESUMEN DE CUENTA" ? `Resumen de ${inv.client}` : `Deuda de ${inv.client}`;
  $("#invShare").hidden = !(navigator.canShare && navigator.share);
  $("#dlgInvoice").showModal();
}

function drawInvoice(inv){
  const {money} = S();
  const c = $("#invCanvas"), ctx = c.getContext("2d");
  const W = 820, P = 44, ROW = 34;
  const H = 300 + inv.lines.length * ROW + 170;
  const scale = 2;                                   // nítida al hacer zoom o imprimir
  c.width = W * scale; c.height = H * scale;
  c.style.width = W + "px";
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const F = "'Barlow', Arial, sans-serif", FD = "'Barlow Semi Condensed', 'Arial Narrow', Arial, sans-serif";
  // Colores del logo de Librería Cafe
  const ink = "#2B1520", muted = "#7D5A69", line = "#F2D6E0", accent = "#D81B6A";
  const text = (t, x, y, font, color = ink, align = "left") => { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(t, x, y); };
  const fit = (t, maxW, font) => { ctx.font = font; if (ctx.measureText(t).width <= maxW) return t; while (t.length > 3 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1); return t + "…"; };

  ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);
  // Franja de lápices de colores
  ["#E91E63","#FF7A00","#FFC21A","#43B649","#1E9BE9","#8E44C9"].forEach((col, i, arr) => {
    ctx.fillStyle = col; ctx.fillRect(i * W / arr.length, 0, W / arr.length + 1, 8);
  });

  // Logo + nombre del comercio
  const LOGO = 100, lx = P, ly = 26;
  if (logoImg.complete && logoImg.naturalWidth) ctx.drawImage(logoImg, lx, ly, LOGO, LOGO);
  else logoImg.onload = () => drawInvoice(inv);
  const tx = lx + LOGO + 18;
  let y = 68;
  text(fit(business.name || "Librería Cafe", 300, `700 32px ${FD}`), tx, y, `700 32px ${FD}`, accent);
  const info = [business.address, business.phone && "Tel: " + business.phone, business.cuit && "CUIT: " + business.cuit].filter(Boolean);
  info.forEach((t, i) => text(fit(t, 300, `400 15px ${F}`), tx, y + 24 + i * 20, `400 15px ${F}`, muted));
  // Título
  text(inv.title, W - P, y - 4, `700 20px ${FD}`, accent, "right");
  text("Emitido: " + fmtFull(Date.now()), W - P, y + 22, `400 15px ${F}`, muted, "right");

  y = 160;
  ctx.fillStyle = line; ctx.fillRect(P, y, W - 2 * P, 1);
  y += 34;
  text("Cliente:", P, y, `600 16px ${F}`, muted);
  text(fit(inv.client, 520, `700 20px ${F}`), P + 72, y, `700 20px ${F}`);
  text(inv.period, W - P, y, `600 16px ${F}`, muted, "right");

  // Tabla
  y += 30;
  const cols = {date: P + 10, desc: P + 92, qty: W - P - 270, unit: W - P - 140, amount: W - P - 10};
  ctx.fillStyle = "#FDE2EE"; ctx.fillRect(P, y, W - 2 * P, ROW);
  const hy = y + 22, hf = `700 13px ${F}`;
  text("FECHA", cols.date, hy, hf, muted);
  text("PRODUCTO / DETALLE", cols.desc, hy, hf, muted);
  text("CANT.", cols.qty, hy, hf, muted, "right");
  text("P. UNIT.", cols.unit, hy, hf, muted, "right");
  text("SUBTOTAL", cols.amount, hy, hf, muted, "right");
  y += ROW;
  inv.lines.forEach((l, i) => {
    if (i % 2) { ctx.fillStyle = "#FFF6F8"; ctx.fillRect(P, y, W - 2 * P, ROW); }
    const ty = y + 22, rf = `400 15px ${F}`;
    text(l.date, cols.date, ty, rf, muted);
    text(fit(l.desc, cols.qty - cols.desc - 60, rf), cols.desc, ty, rf);
    text(String(l.qty), cols.qty, ty, rf, ink, "right");
    text(money(l.unit), cols.unit, ty, rf, ink, "right");
    text(money(l.amount), cols.amount, ty, `600 15px ${F}`, ink, "right");
    y += ROW;
  });
  ctx.fillStyle = ink; ctx.fillRect(P, y, W - 2 * P, 2);

  // Total
  y += 52;
  text("TOTAL", W - P - 230, y, `700 18px ${FD}`, muted, "right");
  text(money(inv.total), W - P - 10, y + 2, `700 34px ${FD}`, accent, "right");
  text(`${inv.lines.length} ítem${inv.lines.length === 1 ? "" : "s"}`, P + 10, y, `400 15px ${F}`, muted);

  // Sello de pagado
  if (inv.paid) {
    ctx.save();
    ctx.translate(P + 180, y - 10); ctx.rotate(-0.12);
    ctx.strokeStyle = "#1C7A4A"; ctx.lineWidth = 3;
    ctx.strokeRect(-10, -32, 250, 46);
    text(inv.paid, 115, 0, `700 18px ${FD}`, "#1C7A4A", "center");
    ctx.restore();
  }

  // Pie
  text("Documento no válido como factura.", W / 2, H - 28, `400 13px ${F}`, muted, "center");
}

function invoiceText(inv){
  const {money} = S();
  const out = [];
  out.push(`*${business.name || "Librería Cafe"}*`);
  out.push(`${inv.title === "RESUMEN DE CUENTA" ? "Resumen de cuenta" : "Detalle de deuda"} – ${inv.client}`);
  out.push(inv.period);
  out.push("");
  inv.lines.forEach(l => out.push(`${l.date}  ${l.desc}  ${l.qty} × ${money(l.unit)} = ${money(l.amount)}`));
  out.push("");
  out.push(`*TOTAL: ${money(inv.total)}*`);
  if (inv.paid) out.push(inv.paid);
  return out.join("\n");
}
const fileName = inv => inv.file.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-") + ".png";

$("#invCopy").addEventListener("click", () => {
  if (!invoice) return;
  const t = invoiceText(invoice);
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject())
    .then(() => S().toast("Resumen copiado. Pegalo en WhatsApp o en un mensaje."),
          () => S().toast("No se pudo copiar. Usá “Descargar imagen”."));
});
$("#invDownload").addEventListener("click", () => {
  if (!invoice) return;
  $("#invCanvas").toBlob(b => S().saveFile(fileName(invoice), b), "image/png");
});
$("#invShare").addEventListener("click", () => {
  if (!invoice) return;
  const inv = invoice;
  $("#invCanvas").toBlob(async b => {
    const file = new File([b], fileName(inv), {type: "image/png"});
    const data = {files: [file], title: inv.title + " – " + inv.client, text: invoiceText(inv)};
    try {
      if (navigator.canShare(data)) await navigator.share(data);
      else await navigator.share({title: data.title, text: data.text});
    } catch (e) { if (e && e.name !== "AbortError") S().toast("No se pudo compartir. Usá “Descargar imagen”."); }
  }, "image/png");
});

window.Caja = {start, stop, undoSale};
})();
