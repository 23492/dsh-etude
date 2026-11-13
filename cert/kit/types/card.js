// Leerladder card script (body of async function (etude)). One script for every ladder type; prepare
// decides the mode, this draws it.
// In Etude's browser build the frame's base stylesheet comes after the theme, so card.css's dark
// defaults win over a light theme. Re-apply the theme's variables after everything, and follow changes.
{
  const theme = document.getElementById("etude-theme");
  if (theme && !document.getElementById("sfl-theme")) {
    const own = document.createElement("style");
    own.id = "sfl-theme";
    const sync = () => (own.textContent = theme.textContent.replace(/:root\s*\{/, "html:root {"));
    sync();
    document.head.append(own);
    new MutationObserver(sync).observe(theme, { childList: true, characterData: true, subtree: true });
  }
}
const v = etude.view;
const esc = etude.escape;
// Learner-facing words, filled in by build.py from cert.json "ui" (Dutch by default).
const UI = __UI__;
const prefs = etude.prefs || {};

// ---------- teach: the material, nothing to answer ----------
// Etude's big button submits; grade.js scores it 1. Once the result is in, the card rates it straight
// away: Good, or Easy after "Wist ik al". It sends the rating the way the runtime forwards a key press
// (postMessage "key" "3"/"4", which the study page handles as the rating keys), so it is one tap.
if (v.teach) {
  etude.root.classList.add("sfa-teaching");
  const box = etude.$(".sfa-teach");
  box.hidden = false;
  box.innerHTML = `
    ${v.lesson ? `<details class="sfa-lesson"${prefs.lessonClosed ? "" : " open"}><summary>${esc(v.topic || UI.lesson)}</summary><div class="prose">${etude.md(v.lesson)}</div></details>` : ""}
    <div class="prose sfa-body">${etude.md(v.teach)}</div>
    ${Array.isArray(v.teachOptions) ? `<div class="sfa-opts">${v.teachOptions.map((o) => `<div class="sfa-opt ${o.ok ? "ok" : "no"}"><div class="prose">${etude.md(o.md)}</div></div>`).join("")}</div>` : ""}
    ${v.teachAfter ? `<div class="prose sfa-after">${etude.md(v.teachAfter)}</div>` : ""}
    <button type="button" class="sfa-known only-answer">${esc(UI.known)}</button>`;
  const lesson = etude.$(".sfa-lesson");
  lesson?.addEventListener("toggle", () => etude.setPref("lessonClosed", !lesson.open));
  let known = false;
  etude.morph = false;
  etude.setReady(true);
  etude.getAnswer(() => ({ known }));
  etude.$(".sfa-known").addEventListener("click", () => { known = true; etude.submit({ known: true }); });
  etude.onResult(({ answer }) => {
    if (etude.mode === "preview" || document.body.dataset.preview) return;
    const rating = answer && answer.known ? "4" : "3";
    setTimeout(() => parent.postMessage({ etude: 1, type: "key", key: rating }, "*"), 60);
  });
  return;
}

const q = etude.$(".sfl-q");
if (v.prompt) {
  q.innerHTML = etude.md(v.prompt);
  const n = q.textContent.length;
  if (n > 260 || q.querySelector("pre, ul, ol, table")) q.classList.add("q-long");
  else if (n > 110) q.classList.add("q-mid");
} else q.remove();
const body = etude.$(".sfl-body");
const extra = () => etude.$(".sfl-extra");

// ---------- multiple choice (herken, examen) ----------
function mc() {
  const labels = "ABCDEFGHI";
  // Both extra steps are opt-in (etude type prefs sfl-examen --set commit=true / confidence=true).
  const commit = v.commit && prefs.commit === true && etude.mode === "answer" && etude.answer == null;
  const askConf = v.confidence && prefs.confidence === true;
  body.innerHTML = `
    ${commit ? `<div class="sfl-commit">
      <textarea class="e-textarea sfl-guess" rows="2" autofocus></textarea>
      <div class="e-row"><button type="button" class="e-btn sfl-show">${esc(UI.options)}</button></div>
    </div>` : ""}
    ${v.multiple && !/choose|select|all that apply|kies/i.test(v.prompt ?? "") ? `<div class="e-muted sfl-hint">${esc(UI.pickAll)}</div>` : ""}
    ${v.gok ? `<button type="button" class="sfa-known sfa-gok only-answer" aria-pressed="false">${esc(UI.guess)}</button>` : ""}
    <div class="sfl-opts e-stack"${commit ? " hidden" : ""}>${v.options.map((o, i) => `
      <button type="button" class="e-option" data-id="${o.id}" aria-pressed="false">
        <span class="e-key">${labels[i] ?? ""}</span>
        <span class="body"><span class="prose">${etude.md(o.text)}</span><span class="e-why only-result"></span></span>
      </button>`).join("")}</div>
    ${askConf ? `<div class="sfl-conf e-row" hidden>
      <button type="button" class="e-btn" data-c="1">${esc(UI.confGuess)}</button>
      <button type="button" class="e-btn" data-c="2">${esc(UI.confThink)}</button>
      <button type="button" class="e-btn" data-c="3">${esc(UI.confSure)}</button>
    </div>` : ""}`;
  const prev = etude.answer && typeof etude.answer === "object" && !Array.isArray(etude.answer) ? etude.answer : { picked: etude.answer };
  const selected = new Set(Array.isArray(prev.picked) ? prev.picked : []);
  let confidence = prev.confidence ?? null;
  // "Ik gok" (practice questions): tap before picking when you don't know. A right guess counts as a miss.
  let gok = !!prev.gok;
  const gokBtn = etude.$(".sfa-gok");
  const paintGok = () => gokBtn?.setAttribute("aria-pressed", String(gok));
  gokBtn?.addEventListener("click", () => { gok = !gok; paintGok(); });
  paintGok();
  let stage = commit ? "commit" : "pick";
  const buttons = etude.$$(".e-option");
  const opts = etude.$(".sfl-opts"), conf = etude.$(".sfl-conf"), guess = etude.$(".sfl-guess");
  const paint = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(selected.has(b.dataset.id))));
  const showOptions = () => {
    stage = "pick";
    opts.hidden = false;
    etude.$(".sfl-commit")?.classList.add("done");
    if (guess) guess.disabled = true;
    buttons[0]?.focus();
  };
  const finish = () => {
    if (!selected.size) return;
    if (askConf && confidence == null) {
      stage = "conf";
      conf.hidden = false;
      conf.querySelector("button")?.focus();
      return;
    }
    etude.submit();
  };
  const toggle = (id) => {
    if (etude.mode !== "answer" || stage === "commit") return;
    if (v.multiple) selected.has(id) ? selected.delete(id) : selected.add(id);
    else { selected.clear(); selected.add(id); }
    paint();
    etude.setReady(selected.size > 0);
    if (!v.multiple) finish();
  };
  buttons.forEach((b) => b.addEventListener("click", () => toggle(b.dataset.id)));
  etude.$(".sfl-show")?.addEventListener("click", showOptions);
  conf?.querySelectorAll("[data-c]").forEach((b) => b.addEventListener("click", () => { confidence = Number(b.dataset.c); etude.submit(); }));
  guess?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); showOptions(); }
  });
  window.addEventListener("keydown", (e) => {
    if (etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey || stage === "commit") return;
    const k = e.key.toLowerCase();
    if (stage === "conf" && "123".includes(k) && k.length === 1) { e.preventDefault(); confidence = Number(k); etude.submit(); return; }
    const i = "123456789".includes(k) && k.length === 1 ? Number(k) - 1 : "abcdefghi".indexOf(k);
    if (i >= 0 && i < buttons.length && k.length === 1) { e.preventDefault(); toggle(buttons[i].dataset.id); return; }
    if (e.key === "Enter" && v.multiple && selected.size) { e.preventDefault(); finish(); }
  });
  paint();
  etude.setReady(stage !== "commit" && selected.size > 0);
  etude.getAnswer(() => ({ picked: [...selected], confidence, guess: guess ? guess.value.trim() : "", gok }));
  etude.onResult(({ key, answer }) => {
    opts.hidden = false;
    if (conf) conf.hidden = true;
    gokBtn?.remove();
    etude.$(".sfl-commit")?.remove();
    const a = answer && typeof answer === "object" && !Array.isArray(answer) ? answer : { picked: answer };
    const mine = new Set(Array.isArray(a.picked) ? a.picked : []);
    const right = new Set(key.correct ?? []);
    buttons.forEach((b) => {
      const id = b.dataset.id;
      b.disabled = true;
      b.setAttribute("aria-pressed", "false");
      if (right.has(id) && mine.has(id)) b.classList.add("is-correct");
      else if (right.has(id)) b.classList.add(v.multiple && mine.size ? "is-missed" : "is-correct");
      else if (mine.has(id)) b.classList.add("is-wrong");
      const why = key.why?.[id];
      if (why && (right.has(id) || mine.has(id))) b.querySelector(".e-why").innerHTML = etude.md(why);
    });
    if (a.guess && extra()) extra().innerHTML = `<i>${esc(a.guess)}</i>`;
  });
}

// ---------- cloze (produceer) ----------
function cloze() {
  const marker = (i) => `ETUDEBLANK${i}X`;
  let html = etude.md(v.text.replace(/\u27e6(\d+)\u27e7/g, (_, i) => marker(i)));
  html = html.replace(/ETUDEBLANK(\d+)X/g, (_, i) => {
    const b = v.blanks[i];
    const size = Math.min(40, Math.max(3, Math.ceil(b.size * 0.75), b.hint ? Math.ceil(b.hint.length * 0.8) : 0));
    return `<span class="blank"><input class="e-input" data-i="${i}" size="${size}" autocomplete="off" spellcheck="false" placeholder="${esc(b.hint)}"><span class="fix only-result"></span></span>`;
  });
  body.innerHTML = `<div class="prose sfl-cloze">${html}</div>`;
  const inputs = etude.$$("input[data-i]");
  if (Array.isArray(etude.answer)) inputs.forEach((el, i) => (el.value = etude.answer[i] ?? ""));
  inputs[0]?.setAttribute("autofocus", "");
  etude.getAnswer(() => inputs.map((el) => el.value));
  inputs.forEach((el, i) => el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (i < inputs.length - 1) inputs[i + 1].focus(); else etude.submit();
  }));
  etude.onResult(({ grade, key }) => {
    const marks = grade?.details?.marks ?? [];
    inputs.forEach((el, i) => {
      el.disabled = true;
      const val = el.value.trim();
      const fix = el.nextElementSibling;
      el.style.display = "none";
      fix.className = `fix czr ${marks[i] ? "ok" : "no"}`;
      fix.innerHTML = marks[i] ? esc(val) : `${val ? `<s>${esc(val)}</s>` : ""}<b>${esc(key?.answers?.[i]?.[0] ?? "")}</b>`;
    });
  });
}

// ---------- bank (produceer): drag blocks into the gaps, no typing ----------
// Drag a block onto a gap, or tap a block to drop it in the selected (else first empty) gap. Tap a filled gap
// to send its block back. Dropping on a filled gap swaps.
function bank() {
  const marker = (i) => `ETUDEBLANK${i}X`;
  let html = etude.md(v.text.replace(/\u27e6(\d+)\u27e7/g, (_, i) => marker(i)));
  html = html.replace(/ETUDEBLANK(\d+)X/g, (_, i) => `<span class="gap" data-i="${i}" tabindex="0" role="button"></span>`);
  body.innerHTML = `<div class="prose sfl-cloze sfl-bank-text">${html}</div><div class="wbank">${v.bank.map((b) => `<button type="button" class="wchip" data-id="${b.id}">${esc(b.text)}</button>`).join("")}</div>`;
  const gaps = etude.$$(".gap");
  const chips = etude.$$(".wchip");
  const textOf = Object.fromEntries(v.bank.map((b) => [b.id, b.text]));
  const placed = gaps.map(() => null);
  if (Array.isArray(etude.answer)) etude.answer.forEach((t, i) => { const b = v.bank.find((x) => x.text === t && !placed.includes(x.id)); if (b && i < placed.length) placed[i] = b.id; });
  let sel = null;
  const render = () => {
    gaps.forEach((g, i) => {
      g.textContent = placed[i] ? textOf[placed[i]] : "";
      g.classList.toggle("filled", !!placed[i]);
      g.classList.toggle("sel", sel === i);
    });
    chips.forEach((c) => c.classList.toggle("used", placed.includes(c.dataset.id)));
    etude.setReady(placed.every(Boolean));
  };
  const put = (id, i) => {
    const from = placed.indexOf(id);
    if (from >= 0) placed[from] = placed[i]; // moved between gaps: swap; a block it replaces otherwise goes back to the bank
    placed[i] = id;
    sel = null;
    render();
  };
  const firstEmpty = () => placed.indexOf(null);
  const live = () => etude.mode === "answer";
  // Keyboard: Enter on a gap clears it or selects it.
  gaps.forEach((g, i) => g.addEventListener("keydown", (e) => {
    if (!live() || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (placed[i]) placed[i] = null;
    sel = sel === i ? null : i;
    render();
  }));
  // Pointer drag with a floating copy; a short press without movement counts as a tap.
  let drag = null;
  const gapAt = (x, y) => { const el = document.elementFromPoint(x, y); return el ? el.closest(".gap") : null; };
  const startDrag = (id, e, from) => {
    drag = { id, from, x0: e.clientX, y0: e.clientY, moved: false, ghost: null, pid: e.pointerId };
  };
  const moveDrag = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.ghost = document.createElement("div");
      drag.ghost.className = "wchip ghost";
      drag.ghost.textContent = textOf[drag.id];
      document.body.append(drag.ghost);
    }
    e.preventDefault();
    drag.ghost.style.left = e.clientX + "px";
    drag.ghost.style.top = e.clientY + "px";
    gaps.forEach((g) => g.classList.remove("over"));
    gapAt(e.clientX, e.clientY)?.classList.add("over");
  };
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    gaps.forEach((g) => g.classList.remove("over"));
    if (d.ghost) d.ghost.remove();
    if (!d.moved) {
      if (d.from == null) {
        if (placed.includes(d.id)) return;
        const i = sel != null ? sel : firstEmpty();
        if (i >= 0) put(d.id, i);
      } else { placed[d.from] = null; sel = d.from; render(); }
      return;
    }
    const g = gapAt(e.clientX, e.clientY);
    if (g) {
      const i = Number(g.dataset.i);
      if (d.from != null && placed[i]) { placed[d.from] = placed[i]; placed[i] = d.id; sel = null; render(); }
      else put(d.id, i);
    } else if (d.from != null) { placed[d.from] = null; render(); }
  };
  chips.forEach((c) => c.addEventListener("pointerdown", (e) => {
    if (!live() || e.button > 0 || c.classList.contains("used")) return;
    e.preventDefault();
    c.setPointerCapture?.(e.pointerId);
    startDrag(c.dataset.id, e, null);
  }));
  gaps.forEach((g, i) => g.addEventListener("pointerdown", (e) => {
    if (!live() || e.button > 0) return;
    e.preventDefault();
    if (!placed[i]) { sel = sel === i ? null : i; render(); return; }
    g.setPointerCapture?.(e.pointerId);
    startDrag(placed[i], e, i);
  }));
  window.addEventListener("pointermove", moveDrag, { passive: false });
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", () => { if (drag?.ghost) drag.ghost.remove(); drag = null; gaps.forEach((g) => g.classList.remove("over")); });
  window.addEventListener("keydown", (e) => {
    if (!live() || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = "123456789".indexOf(e.key);
    if (n >= 0 && n < chips.length) { e.preventDefault(); const c = chips[n]; if (!c.classList.contains("used")) { const i = sel != null ? sel : firstEmpty(); if (i >= 0) put(c.dataset.id, i); } }
    if (e.key === "Backspace") { const i = placed.map(Boolean).lastIndexOf(true); if (i >= 0) { e.preventDefault(); placed[i] = null; render(); } }
    if (e.key === "Enter" && placed.every(Boolean)) { e.preventDefault(); etude.submit(); }
  });
  render();
  etude.getAnswer(() => placed.map((id) => (id ? textOf[id] : "")));
  etude.onResult(({ grade, key }) => {
    const marks = grade?.details?.marks ?? [];
    etude.$(".wbank")?.classList.add("done");
    gaps.forEach((g, i) => {
      const val = placed[i] ? textOf[placed[i]] : "";
      g.className = `gap czr ${marks[i] ? "ok" : "no"}`;
      const right = grade?.details?.fix?.[i] ?? key?.answers?.[i]?.[0] ?? "";
      g.innerHTML = marks[i] ? esc(val) : `${val ? `<s>${esc(val)}</s>` : ""}<b>${esc(right)}</b>`;
    });
  });
}

// ---------- typed (produceer) ----------
function typed() {
  body.innerHTML = `<input class="e-input sfl-typed" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(v.placeholder || "")}" autofocus>`;
  const input = etude.$(".sfl-typed");
  if (etude.answer != null) input.value = etude.answer;
  etude.getAnswer(() => input.value);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); etude.submit(); } });
  etude.onResult(({ grade, key, answer }) => {
    input.disabled = true;
    const ok = (grade?.score ?? 0) >= 1;
    input.classList.add(ok ? "is-correct" : "is-wrong");
    const answers = (key?.answers ?? []).map(String);
    if (extra() && !ok) extra().innerHTML = `<b>${esc(answers[0] ?? "")}</b>${answers.length > 1 ? ` \u00b7 ${esc(UI.alsoRight)} ${answers.slice(1).map(esc).join(", ")}` : ""}`;
  });
}

// ---------- match (produceer) ----------
function match() {
  body.innerHTML = `<div class="board"><div class="col left"></div><svg class="wires" aria-hidden="true"></svg><div class="col right"></div></div>`;
  const L = etude.$(".left"), R = etude.$(".right"), svg = etude.$(".wires"), board = etude.$(".board");
  const chip = (side, o, i) => `<button type="button" class="e-option chip" data-side="${side}" data-id="${o.id}"><span class="e-key">${side === "l" ? i + 1 : String.fromCharCode(97 + i)}</span><span class="prose">${etude.md(o.text)}</span></button>`;
  L.innerHTML = v.left.map((o, i) => chip("l", o, i)).join("");
  R.innerHTML = v.right.map((o, i) => chip("r", o, i)).join("");
  const given = v.given || {};
  const links = new Map(Object.entries(etude.answer && typeof etude.answer === "object" ? etude.answer : given));
  for (const [l, r] of Object.entries(given)) links.set(l, r);
  let picked = null;
  const el = (id) => board.querySelector(`[data-id="${id}"]`);
  const COLORS = ["#f472b6", "#60a5fa", "#facc15", "#4ade80", "#c084fc", "#fb923c", "#2dd4bf", "#f87171"];
  const colorOf = (lid) => COLORS[v.left.findIndex((o) => o.id === lid) % COLORS.length];
  const locked = (id) => id in given || Object.values(given).includes(id);
  function draw(marks) {
    const box = board.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${svg.clientWidth} ${box.height}`);
    svg.style.height = box.height + "px";
    const sb = svg.getBoundingClientRect();
    let paths = "";
    for (const [l, r] of links) {
      const a = el(l).getBoundingClientRect(), b = el(r).getBoundingClientRect();
      const y1 = a.top + a.height / 2 - sb.top, y2 = b.top + b.height / 2 - sb.top, w = sb.width;
      const wrong = marks && !marks[l];
      const stroke = wrong ? "var(--danger)" : colorOf(l);
      paths += `<path d="M0 ${y1} C ${w / 2} ${y1}, ${w / 2} ${y2}, ${w} ${y2}" stroke="${stroke}" stroke-width="2" fill="none"${wrong ? ' stroke-dasharray="4 4"' : ""}/>`;
    }
    svg.innerHTML = paths;
    board.querySelectorAll(".chip").forEach((c) => {
      const id = c.dataset.id;
      const lid = c.dataset.side === "l" ? (links.has(id) ? id : null) : [...links].find(([, r]) => r === id)?.[0];
      c.style.setProperty("--wire", lid ? colorOf(lid) : "transparent");
      c.classList.toggle("linked", !!lid);
      c.classList.toggle("is-selected", picked === id);
      c.classList.toggle("given", locked(id));
    });
    etude.setReady(links.size === v.left.length);
  }
  board.addEventListener("click", (e) => {
    const c = e.target.closest(".chip");
    if (!c || etude.mode !== "answer" || locked(c.dataset.id)) return;
    const { side, id } = c.dataset;
    if (side === "l") {
      if (links.has(id)) { links.delete(id); picked = null; } else picked = picked === id ? null : id;
    } else {
      const owner = [...links].find(([, r]) => r === id)?.[0];
      if (owner) links.delete(owner);
      else if (picked) { links.set(picked, id); picked = null; }
    }
    draw();
  });
  new ResizeObserver(() => draw(etude.result?.grade?.details?.marks)).observe(board);
  etude.getAnswer(() => Object.fromEntries(links));
  draw();
  etude.onResult(({ grade, key }) => {
    const marks = grade?.details?.marks ?? {};
    board.querySelectorAll(".chip").forEach((c) => (c.disabled = true));
    for (const [l, ok] of Object.entries(marks)) {
      el(l).classList.add(ok ? "is-correct" : "is-wrong");
      if (!ok) {
        const fix = document.createElement("span");
        fix.className = "e-why fix";
        fix.innerHTML = "\u2192 " + etude.mdInline(key.text[key.pairs[l]]);
        el(l).querySelector(".prose").append(fix);
      }
    }
    draw(marks);
  });
}

// ---------- order (produceer) ----------
function order() {
  const fixed = v.fixed ? v.blocks.find((b) => b.id === v.fixed) : null;
  let blocks = v.blocks.filter((b) => b.id !== v.fixed);
  if (Array.isArray(etude.answer)) {
    const byId = Object.fromEntries(v.blocks.map((b) => [b.id, b]));
    blocks = etude.answer.map((id) => byId[id]).filter((b) => b && b.id !== v.fixed);
  }
  body.innerHTML = `${fixed ? `<div class="block given"><span class="num">1</span><span class="prose">${etude.md(fixed.text)}</span></div>` : ""}
    <ol class="blocks"></ol>`;
  const list = etude.$(".blocks");
  const off = fixed ? 1 : 0;
  const render = () => {
    list.innerHTML = blocks.map((b, i) => `<li class="block" data-id="${b.id}" tabindex="0"><span class="grip" aria-hidden="true">\u22ee\u22ee</span><span class="num">${i + 1 + off}</span><span class="prose">${etude.md(b.text)}</span></li>`).join("");
  };
  render();
  etude.getAnswer(() => [...(fixed ? [fixed.id] : []), ...blocks.map((b) => b.id)]);
  const move = (from, to) => {
    if (to < 0 || to >= blocks.length || from === to) return;
    const [b] = blocks.splice(from, 1);
    blocks.splice(to, 0, b);
    render();
  };
  list.addEventListener("keydown", (e) => {
    const li = e.target.closest(".block");
    if (!li || etude.mode !== "answer") return;
    const i = blocks.findIndex((b) => b.id === li.dataset.id);
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      move(i, e.key === "ArrowUp" ? i - 1 : i + 1);
      list.querySelector(`[data-id="${li.dataset.id}"]`)?.focus();
    }
  });
  let drag = null;
  list.addEventListener("pointerdown", (e) => {
    const li = e.target.closest(".block");
    if (!li || etude.mode !== "answer" || e.button !== 0) return;
    e.preventDefault();
    drag = { li, startY: e.clientY, rects: [...list.children].map((c) => c.getBoundingClientRect()), from: [...list.children].indexOf(li), to: null };
    li.setPointerCapture(e.pointerId);
    li.classList.add("dragging");
  });
  list.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    drag.li.style.transform = `translateY(${dy}px)`;
    const center = drag.rects[drag.from].top + drag.rects[drag.from].height / 2 + dy;
    let to = drag.rects.findIndex((r) => center < r.top + r.height / 2);
    if (to === -1) to = drag.rects.length - 1; else if (to > drag.from) to -= 1;
    drag.to = to;
  });
  const end = () => {
    if (!drag) return;
    const { from, to } = drag;
    drag = null;
    if (to != null && to !== from) move(from, to); else render();
  };
  list.addEventListener("pointerup", end);
  list.addEventListener("pointercancel", end);
  etude.onResult(({ key }) => {
    const pos = Object.fromEntries(key.order.map((id, i) => [id, i]));
    list.querySelectorAll(".block").forEach((li, i) => li.classList.add(pos[li.dataset.id] === i + off ? "is-correct" : "is-wrong"));
    if (extra()) extra().innerHTML = `<div class="e-section-title">${esc(UI.rightOrder)}</div><ol class="solution">${key.steps.map((s) => `<li class="prose">${etude.md(s)}</li>`).join("")}</ol>`;
  });
}

// ---------- reveal (onthoud: free recall, self-rated) ----------
function reveal() {
  body.innerHTML = `<textarea class="e-textarea sfl-recall" rows="3" autofocus></textarea>`;
  const ta = etude.$(".sfl-recall");
  if (typeof etude.answer === "string") ta.value = etude.answer;
  etude.getAnswer(() => ta.value);
  etude.onResult(({ answer }) => {
    ta.remove();
        if (extra() && answer) extra().innerHTML = `<i>${esc(String(answer))}</i>`;
  });
}

// ---------- free (onthoud for explanation cards: AI-graded) ----------
function free() {
  body.innerHTML = `<textarea class="e-textarea sfl-free" rows="4" autofocus></textarea>`;
  const ta = etude.$(".sfl-free");
  if (typeof etude.answer === "string") ta.value = etude.answer;
  const ready = () => etude.setReady(ta.value.trim().length > 0);
  ta.addEventListener("input", ready);
  ready();
  etude.getAnswer(() => ta.value);
  etude.onResult(() => { ta.disabled = true; });
}

({ mc, cloze, bank, typed, match, order, reveal, free })[v.mode]();
