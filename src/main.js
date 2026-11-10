import { initializeApp } from "firebase/app";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, query, orderBy, limit, updateDoc, writeBatch,
  serverTimestamp, increment
} from "firebase/firestore";
import { getAI, getGenerativeModel, GoogleAIBackend, ThinkingLevel } from "firebase/ai";

/* ================= Firebase ================= */
const firebaseConfig = {
  apiKey: "AIzaSyAwREaxu5JD6p6HYr2g6Wj2Gx6xH6AVjPw",
  authDomain: "lumi-lens.firebaseapp.com",
  projectId: "lumi-lens",
  storageBucket: "lumi-lens.firebasestorage.app",
  messagingSenderId: "229836640245",
  appId: "1:229836640245:web:5ac76ed28f6ac1d74a1abc"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let db;
try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { db = initializeFirestore(app, {}); }
const ai = getAI(app, { backend: new GoogleAIBackend() });
const MODELS = { fast: "gemini-3.5-flash-lite", accurate: "gemini-3.5-flash" };

/* ================= helpers ================= */
const $ = id => document.getElementById(id);
const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
// CEFR level shown with a colour per band: A = green, B1 = blue, B2 = violet, C = amber.
const RARITY = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 5 };
const rarity = lv => RARITY[lv] || 4;
const POS = { "n.": "noun", "v.": "verb", "adj.": "adjective", "adv.": "adverb", "phr. v.": "phrasal verb", "idiom": "idiom" };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const secs = ms => (ms / 1000).toFixed(1);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2400); }
function showErr(msg) { const el = $("srcErr"); el.textContent = msg || ""; el.hidden = !msg; }
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const press = (sel, v) => document.querySelectorAll(sel).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === v)));

/* ================= settings + theme ================= */
const S = Object.assign({ src: "auto", tgt: "Thai", lv: "B2", auto: true, autoCap: false, quality: "fast", view: "card", theme: "system", accent: "violet" }, store.get("lumi.settings", {}));
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const dark = S.theme === "dark" || (S.theme === "system" && darkMQ.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.accent = S.accent;
}
if (darkMQ.addEventListener) darkMQ.addEventListener("change", applyTheme);
function paintSettings() {
  $("hSrc").value = S.src; $("hTgt").value = S.tgt;
  $("swap").disabled = S.src === "auto";
  press("#seg button", S.lv); press("#segQ button", S.quality); press("#segMode button", S.view);
  press("#segTheme button", S.theme); press("#swatches button", S.accent);
  $("autoTr").setAttribute("aria-pressed", String(!!S.auto));
}
function saveSettings() { store.set("lumi.settings", S); applyTheme(); paintSettings(); }
applyTheme(); paintSettings();
$("hSrc").onchange = e => { S.src = e.target.value; if (S.src === S.tgt) S.tgt = S.src === "Thai" ? "English" : "Thai"; saveSettings(); };
$("hTgt").onchange = e => { S.tgt = e.target.value; if (S.src === S.tgt) S.src = "auto"; saveSettings(); };
$("swap").onclick = () => { if (S.src === "auto") return; [S.src, S.tgt] = [S.tgt, S.src]; saveSettings(); };
const segPick = (id, key, after) => { $(id).onclick = e => { const b = e.target.closest("button"); if (!b) return; S[key] = b.dataset.v; saveSettings(); if (after) after(); }; };
segPick("seg", "lv"); segPick("segQ", "quality"); segPick("segTheme", "theme"); segPick("swatches", "accent");
segPick("segMode", "view", () => { resetLive(); state.text = ""; applyView(); toast(S.view === "card" ? "โหมดการ์ด: ถ่ายแล้วคำแปลขึ้นเป็นการ์ด" : "โหมดแปะทับ: ส่องไปที่ข้อความ คำแปลจะแปะทับเอง"); });
$("autoTr").onclick = () => { S.auto = !S.auto; saveSettings(); };


/* ================= Gemini ================= */
let noThink = false;
function model() {
  return getGenerativeModel(ai, {
    model: MODELS[S.quality] || MODELS.fast,
    generationConfig: noThink ? {} : { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
  });
}
async function streamText(parts, onText, signal) {
  const run = async () => {
    const res = await model().generateContentStream(parts, { signal });
    let text = "";
    for await (const ch of res.stream) {
      let t = ""; try { t = ch.text(); } catch (e) {}
      if (t) { text += t; onText(text); }
    }
    return text;
  };
  try { return await run(); }
  catch (e) {
    if (!signal.aborted && !noThink && /thinking/i.test(String(e?.message))) { noThink = true; return await run(); }
    throw e;
  }
}
function aiErr(e) {
  const code = String(e?.code || "");
  const body = String(e?.message || e || "").replace(/https?:\/\/\S+/g, "");
  const detail = " [" + (code || "error") + ": " + body.replace(/\s+/g, " ").slice(0, 140) + "]";
  if (!navigator.onLine) return "ไม่มีอินเทอร์เน็ตค่ะ ต่อเน็ตแล้วลองใหม่นะคะ";
  if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(body)) return "โควตาฟรีของ Gemini เต็มชั่วคราวค่ะ รอสักนาทีแล้วลองใหม่นะคะ";
  if (/App Check/i.test(body)) return "Firebase ยังบล็อกการเรียก Gemini อยู่ค่ะ (App Check)" + detail;
  if (code === "api-not-enabled" || /has not been used|SERVICE_DISABLED|API_NOT_ENABLED/i.test(body)) return "ยังไม่ได้เปิด AI Logic ใน Firebase ค่ะ" + detail;
  if (/SAFETY|blocked/i.test(body)) return "Gemini ไม่ตอบภาพนี้ค่ะ ลองถ่ายใหม่ให้เห็นแค่ข้อความนะคะ";
  if (/Failed to fetch|NetworkError|network/i.test(body)) return "เชื่อมต่อไม่ได้ค่ะ เช็กอินเทอร์เน็ตแล้วลองใหม่นะคะ";
  return "เกิดข้อผิดพลาดค่ะ ลองใหม่อีกครั้งนะคะ" + detail;
}

/* ================= state ================= */
const state = { text: "", words: [], tr: "", blocks: [], thumb: null, img: null, busy: false, ocrCtl: null, trCtl: null, pageId: null, pageArticle: null, pageNo: 0 };
let user = null;
let cur = { id: null, title: "บทความใหม่", count: 0 };
const memo = new Map(Object.entries(store.get("lumi.cache", {})));
function remember(k, v) {
  memo.set(k, v);
  while (memo.size > 150) memo.delete(memo.keys().next().value);
  store.set("lumi.cache", Object.fromEntries(memo));
}
function loadCur() { cur = store.get("lumi.cur." + user.uid, { id: null, title: "บทความใหม่", count: 0 }); paintCur(); setLastThumb(store.get("lumi.thumb." + user.uid, null)); }
function saveCur() { if (user) store.set("lumi.cur." + user.uid, cur); paintCur(); }
function paintCur() {}
function setLastThumb(src, save) {
  if (save && user) store.set("lumi.thumb." + user.uid, src);
}

/* ================= auth ================= */
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
function loginErr(e) {
  const c = e?.code || "";
  const msg = c === "auth/network-request-failed" ? "เชื่อมต่อไม่ได้ค่ะ เช็กอินเทอร์เน็ตแล้วลองใหม่นะคะ"
    : c === "auth/operation-not-allowed" ? "ยังไม่ได้เปิดล็อกอินด้วย Google ใน Firebase ค่ะ"
    : "ล็อกอินไม่สำเร็จค่ะ ลองใหม่อีกครั้งนะคะ (" + (c || e?.message || "") + ")";
  const el = $("loginErr"); el.textContent = msg; el.hidden = false; $("signin").disabled = false;
}
getRedirectResult(auth).catch(loginErr);
const useRedirect = matchMedia("(pointer: coarse)").matches || matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
$("signin").onclick = async () => {
  $("loginErr").hidden = true;
  if (useRedirect) { $("signin").disabled = true; signInWithRedirect(auth, provider).catch(loginErr); return; }
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e.code)) signInWithRedirect(auth, provider).catch(loginErr);
    else if (e.code !== "auth/popup-closed-by-user") loginErr(e);
  }
};
$("signout").onclick = async () => { closePanels(); await signOut(auth); };
onAuthStateChanged(auth, u => {
  user = u; $("boot").hidden = true;
  $("login").hidden = !!u; $("app").hidden = !u;
  if (u) {
    $("whoName").textContent = u.displayName ? `${u.displayName} · ${u.email || ""}` : (u.email || "");
    galleryStale = true; loadCur(); goLive();
  } else { stopCam(); closePanels(); }
});

/* ================= camera ================= */
const cam = $("cam"), photo = $("photo");
let stream = null, mode = "live", camStarting = false, camTries = 0, shooting = false;
function camMsg(text, withBtn) {
  const el = $("camMsg");
  if (!text) { el.hidden = true; el.innerHTML = ""; return; }
  el.innerHTML = `<div><p>${esc(text)}</p>${withBtn ? '<button class="btn-grad" type="button" id="camRetry">เปิดกล้อง</button>' : ""}</div>`;
  el.hidden = false;
  const b = $("camRetry"); if (b) b.onclick = () => startCam();
}
const track = () => stream && stream.getVideoTracks()[0];
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
async function openStream(deviceId) {
  // zoom: true asks for the camera's real zoom control; focusMode continuous keeps autofocus running
  const size = { width: { ideal: 3840 }, height: { ideal: 2160 }, zoom: true, advanced: [{ focusMode: "continuous" }] };
  const video = deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: "environment" }, ...size };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}
const CAM_KEY = "lumi.cam2";
async function backCams() {
  try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput" && !/front|user|หน้า|facetime/i.test(d.label)); }
  catch (e) { return []; }
}
// iPhone: the "triple" / "dual wide" camera switches to the macro lens by itself when close, like the Camera app
const iosRank = l => /triple|สามตัว|สามเลนส์/i.test(l) ? 3 : /dual wide|คู่มุมกว้าง|คู่แบบกว้าง/i.test(l) ? 2 : /dual|คู่/i.test(l) ? 1 : 0;
async function useCamera(id) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  stream = await openStream(id); cam.srcObject = stream; await cam.play().catch(() => {});
  photoCaps = null;
}
async function chooseCamera() {
  const tr = track(); if (!tr) return;
  const curId = tr.getSettings().deviceId;
  const cams = await backCams();
  if (isIOS) {
    const best = cams.map(d => [iosRank(d.label), d]).sort((a, b) => b[0] - a[0])[0];
    if (best && best[0] > 0 && best[1].deviceId !== curId) { try { await useCamera(best[1].deviceId); } catch (e) { await useCamera(null); } }
    return;
  }
  // Android: some phones open a lens without autofocus first (ultra-wide / depth). Prefer one with continuous autofocus.
  const caps = tr.getCapabilities ? tr.getCapabilities() : {};
  if (!caps.focusMode || caps.focusMode.includes("continuous")) return;
  for (const d of cams.filter(d => d.deviceId !== curId).slice(0, 4)) {
    let s2; try { s2 = await openStream(d.deviceId); } catch (e) { continue; }
    const c = s2.getVideoTracks()[0].getCapabilities?.() || {};
    if (c.focusMode && c.focusMode.includes("continuous")) { stream.getTracks().forEach(t => t.stop()); stream = s2; cam.srcObject = s2; await cam.play().catch(() => {}); photoCaps = null; return; }
    s2.getTracks().forEach(t => t.stop());
  }
}
function keepFocus() {
  const tr = track(); if (!tr) return;
  const caps = tr.getCapabilities ? tr.getCapabilities() : {};
  if (caps.focusMode && caps.focusMode.includes("continuous")) tr.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
}
// after the phone moves to something new, refocus once (like the Camera app does), then go back to continuous focus
let lastKick = 0;
function focusKick() {
  const tr = track(); if (!tr || performance.now() - lastKick < 2500) return;
  const caps = tr.getCapabilities ? tr.getCapabilities() : {};
  if (!caps.focusMode || !caps.focusMode.includes("single-shot")) return;
  lastKick = performance.now();
  tr.applyConstraints({ advanced: [{ focusMode: "single-shot", pointsOfInterest: [{ x: 0.5, y: 0.5 }] }] }).catch(() => {}).finally(() => setTimeout(keepFocus, 1200));
}
async function startCam() {
  if (stream || camStarting || !user || document.hidden) return;
  if (!navigator.mediaDevices?.getUserMedia) { camMsg("เบราว์เซอร์นี้เปิดกล้องไม่ได้ค่ะ ใช้ปุ่มเลือกรูปด้านซ้ายล่างแทนนะคะ"); return; }
  camStarting = true;
  try {
    const saved = store.get(CAM_KEY, null);
    try { stream = await openStream(saved); } catch (e) { if (!saved) throw e; stream = await openStream(null); }
    cam.srcObject = stream;
    await cam.play().catch(() => {});
    camMsg("");
    if (!saved) await chooseCamera().catch(() => {});
    keepFocus();
    initZoom();
    paintLens();
    startLoop();
  } catch (e) {
    stream = null;
    camMsg(e && e.name === "NotAllowedError"
      ? "ยังไม่ได้อนุญาตให้ใช้กล้องค่ะ อนุญาตกล้องแล้วกดเปิดกล้อง หรือใช้ปุ่มเลือกรูปด้านซ้ายล่างก็ได้นะคะ"
      : "เปิดกล้องไม่ได้ค่ะ ลองกดเปิดกล้องอีกครั้ง หรือใช้ปุ่มเลือกรูปแทนนะคะ", true);
  } finally { camStarting = false; }
}
/* auto lens: when the picture stays blurry, quietly try the other back lenses and keep the sharpest */
const fCan = document.createElement("canvas"); fCan.width = 192; fCan.height = 144;
const fCtx = fCan.getContext("2d", { willReadFrequently: true });
const lapH = new Uint32Array(1024), grdH = new Uint32Array(256);
// sharpness of the middle of the picture: strong edges stay steep when in focus (works even with camera noise)
function focusScore() {
  const vw = cam.videoWidth, vh = cam.videoHeight; if (!vw) return null;
  const cw = Math.min(384, vw), ch = Math.min(288, vh);
  fCtx.drawImage(cam, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, 192, 144);
  const d = fCtx.getImageData(0, 0, 192, 144).data, W = 192, H = 144, g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2];
  lapH.fill(0); grdH.fill(0); let n = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, p = g[i];
    lapH[Math.min(1023, Math.abs(4 * p - g[i - 1] - g[i + 1] - g[i - W] - g[i + W]) | 0)]++;
    grdH[Math.min(255, Math.max(Math.abs(g[i + 1] - g[i - 1]), Math.abs(g[i + W] - g[i - W])) | 0)]++; n++;
  }
  const pct = (h, q) => { let c = 0; const t = n * q; for (let k = 0; k < h.length; k++) { c += h[k]; if (c >= t) return k; } return h.length - 1; };
  const g99 = pct(grdH, 0.99);
  if (g99 < 18) return null; // nothing with edges in the middle
  return { r: pct(lapH, 0.99) / Math.max(1, g99), g: g99 };
}
const AL = { testing: false, samples: [], done: false, last: 0, settled: 0 };
const BLUR_R = 0.8;
const isBlurry = f => f && (f.r < BLUR_R || f.g < 45);
function autoLensTick(still, edge) {
  if (isIOS || lensList.length < 2 || AL.testing) return;
  const now = performance.now();
  if (!still) { AL.samples = []; AL.done = false; AL.settled = 0; return; }
  if (AL.done || edge < 2.2) return;
  if (!AL.settled) AL.settled = now;
  if (now - AL.settled < 900) return; // give autofocus a moment first
  const f = focusScore(); if (f) AL.samples.push(f);
  if (AL.samples.length < 3) return;
  AL.done = true;
  const blurry = AL.samples.filter(isBlurry).length >= 2;
  if (blurry && now - AL.last > 6000) testLenses();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function measureLens() {
  await sleep(1000); keepFocus(); // let the new lens focus
  const fs = [];
  for (let k = 0; k < 3; k++) { const f = focusScore(); if (f) fs.push(f.r + Math.min(0.4, f.g / 400)); await sleep(140); }
  fs.sort((a, b) => a - b);
  return fs.length ? fs[Math.floor(fs.length / 2)] : 0;
}
async function testLenses() {
  AL.testing = true; AL.last = performance.now();
  const curId = track()?.getSettings().deviceId;
  const snap = grabFrame(1280);
  if (snap) { await showPhoto(snap); photo.hidden = false; } // hold the picture on screen while lenses switch
  liveChip("กำลังปรับความชัด…");
  try {
    const f0 = focusScore();
    const results = [[curId, f0 ? f0.r + Math.min(0.4, f0.g / 400) : 0]];
    for (const d of lensList.filter(d => d.deviceId !== curId).slice(0, 3)) {
      try { await useCamera(d.deviceId); results.push([d.deviceId, await measureLens()]); } catch (e) {}
    }
    const best = results.reduce((a, b) => (b[1] > a[1] * 1.12 ? b : a));
    if (track()?.getSettings().deviceId !== best[0]) await useCamera(best[0]);
    store.set(CAM_KEY, best[0]); keepFocus(); initZoom(); resetLive();
    if (best[0] !== curId) toast(`สลับไปเลนส์ ${lensList.findIndex(d => d.deviceId === best[0]) + 1} ให้แล้วค่ะ ชัดกว่า`);
  } catch (e) { try { await useCamera(curId); } catch (e2) { stream = null; } }
  finally {
    AL.testing = false; AL.samples = []; AL.done = true; liveChip("");
    if (mode === "live") photo.hidden = true;
    prevLum = null; armedAt = performance.now() + 300;
    if (!stream) startCam();
  }
}
window.__lumi = { testLenses, focusScore, lenses: () => lensList };
/* lens button: step through the phone's back cameras if one is blurry up close */
let lensList = [];
async function paintLens() { lensList = await backCams(); $("lensBtn").hidden = lensList.length < 2 || mode !== "live"; }
$("lensBtn").onclick = async e => {
  e.stopPropagation();
  if (lensList.length < 2 || camStarting) return;
  const curId = track()?.getSettings().deviceId;
  const i = Math.max(0, lensList.findIndex(d => d.deviceId === curId));
  const n = (i + 1) % lensList.length;
  camStarting = true;
  try { await useCamera(lensList[n].deviceId); store.set(CAM_KEY, lensList[n].deviceId); keepFocus(); initZoom(); resetLive(); toast(`เลนส์ ${n + 1} จาก ${lensList.length}`); }
  catch (err) { toast("เปลี่ยนเลนส์ไม่ได้ค่ะ"); stream = null; camStarting = false; startCam(); return; }
  finally { camStarting = false; }
};
function stopCam() { stopLoop(); live.ctl?.abort(); if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; cam.srcObject = null; photoCaps = null; }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopCam();
  else if (user && mode === "live") startCam();
});

/* ---------- zoom: the camera's own zoom where the phone allows it, otherwise an enlarged crop ---------- */
const Z = { v: 1, min: 1, max: 4, hw: false, busy: false, want: null };
let zoomTipT;
function initZoom() {
  const c = track()?.getCapabilities?.() || {};
  Z.hw = !!(c.zoom && c.zoom.max > 1.01);
  Z.min = Z.hw ? Math.max(1, c.zoom.min || 1) : 1;
  Z.max = Z.hw ? Math.min(c.zoom.max, 10) : 4;
  renderZoomBar(); setZoom(Z.v, true);
}
const zoomLabel = z => (Math.abs(z - Math.round(z)) < 0.05 ? Math.round(z) : z.toFixed(1)) + "×";
function zoomPresets() { const p = [1]; if (Z.max >= 2) p.push(2); if (Z.max >= 5) p.push(5); else if (Z.max >= 3) p.push(3); return p; }
function renderZoomBar() { $("zoomBar").innerHTML = zoomPresets().map(p => `<button type="button" data-z="${p}">${p}×</button>`).join(""); paintZoom(); }
function paintZoom() {
  const btns = [...$("zoomBar").querySelectorAll("button")];
  let act = btns[0];
  btns.forEach(b => { if (+b.dataset.z <= Z.v + 0.05) act = b; });
  btns.forEach(b => { const on = b === act; b.setAttribute("aria-pressed", String(on)); b.textContent = on ? zoomLabel(Z.v) : b.dataset.z + "×"; });
}
function zoomTip() {
  const t = $("zoomTip"); t.textContent = zoomLabel(Z.v); t.hidden = false;
  clearTimeout(zoomTipT); zoomTipT = setTimeout(() => { t.hidden = true; }, 900);
}
function setZoom(z, quiet) {
  z = Math.round(Math.max(Z.min, Math.min(Z.max, z)) * 10) / 10;
  Z.v = z;
  if (Z.hw) { cam.style.transform = ""; pushHwZoom(z); }
  else cam.style.transform = z > 1 ? `scale(${z})` : "";
  paintZoom(); if (!quiet) zoomTip();
}
function pushHwZoom(z) {
  Z.want = z; if (Z.busy) return;
  const tr = track(); if (!tr) return;
  Z.busy = true; const v = Z.want; Z.want = null;
  tr.applyConstraints({ advanced: [{ zoom: v }] })
    .catch(() => { Z.hw = false; Z.max = 4; renderZoomBar(); cam.style.transform = v > 1 ? `scale(${Math.min(v, 4)})` : ""; })
    .finally(() => { Z.busy = false; if (Z.want != null && Z.hw) pushHwZoom(Z.want); });
}
$("zoomBar").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  e.stopPropagation(); setZoom(+b.dataset.z);
};
// pinch with two fingers to zoom
(() => {
  const st = $("stage"); let d0 = 0, z0 = 1;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  st.addEventListener("touchstart", e => { if (e.touches.length === 2 && mode === "live") { d0 = dist(e.touches); z0 = Z.v; } }, { passive: true });
  st.addEventListener("touchmove", e => {
    if (e.touches.length !== 2 || !d0 || mode !== "live") return;
    e.preventDefault(); setZoom(z0 * dist(e.touches) / d0);
  }, { passive: false });
  st.addEventListener("touchend", e => { if (e.touches.length < 2) d0 = 0; });
})();

/* tap the viewfinder to focus there */
$("stage").addEventListener("click", e => {
  if (mode !== "live" || !stream || e.target.closest(".ov-b")) return;
  const st = $("stage").getBoundingClientRect();
  const ring = $("focusRing"); ring.style.left = e.clientX - st.left + "px"; ring.style.top = e.clientY - st.top + "px";
  ring.classList.remove("on"); void ring.offsetWidth; ring.classList.add("on");
  const tr = track(); const caps = tr.getCapabilities ? tr.getCapabilities() : {};
  const dz = Z.hw ? 1 : Z.v; // with the enlarged crop, the tapped point sits closer to the centre of the real picture
  const fx = 0.5 + ((e.clientX - st.left) / st.width - 0.5) / dz, fy = 0.5 + ((e.clientY - st.top) / st.height - 0.5) / dz;
  const adv = { pointsOfInterest: [{ x: fx, y: fy }] };
  if (caps.focusMode && caps.focusMode.includes("single-shot")) adv.focusMode = "single-shot";
  tr.applyConstraints({ advanced: [adv] }).catch(() => {}).finally(() => setTimeout(keepFocus, 1800));
});

function camChrome(on) {
  $("controls").hidden = !on;
  $("openSet").hidden = !on;
  $("lensBtn").hidden = !on || lensList.length < 2;
  $("reticle").hidden = true;
  $("frameChip").hidden = !on || S.view !== "card";
  paintFrame();
  $("hint").hidden = !on;
  $("hint").textContent = S.view === "overlay" ? "ส่องไปที่ข้อความ คำแปลจะแปะทับให้เอง" : "ส่องไปที่ข้อความ คำแปลจะขึ้นในการ์ดเอง";
}
function unlockRotation() { try { screen.orientation?.lock?.("any").catch(() => {}); } catch (e) {} }
function goLive() {
  unlockRotation();
  abortAll(); resetLive();
  mode = "live"; $("app").classList.add("live"); photo.hidden = true; $("scan").hidden = true; $("freezeX").hidden = true; $("ovBar").hidden = true;
  state.blocks = []; state.canvas = null; state.showOrig = false;
  $("ov").hidden = true; $("ov").innerHTML = ""; $("ov").classList.remove("orig"); liveChip("");
  camChrome(true); sheetTo("away");
  armedAt = performance.now() + 1200;
  if (stream) startLoop(); else startCam();
}
function setFrozen() { mode = "frozen"; $("app").classList.remove("live"); photo.hidden = false; camChrome(false); stopLoop(); liveChip(""); }
// X on the live card: put it away until the camera moves to something new
$("retake").onclick = () => { if (mode === "live") { L.mute = true; L.wctl?.abort(); sheetTo("away"); $("hint").hidden = false; } else goLive(); };
$("keepBtn").onclick = () => saveCard();
$("freezeX").onclick = goLive;

/* ---------- getting a picture ---------- */
// Crop any source to what the viewfinder shows (the video is drawn with object-fit: cover, and maybe enlarged).
function cropToView(src, sw, sh, max) {
  const st = $("stage").getBoundingClientRect();
  const sc = Math.max(st.width / sw, st.height / sh);
  const dz = Z.hw ? 1 : Z.v;
  const cw = Math.min(sw, st.width / sc) / dz, ch = Math.min(sh, st.height / sc) / dz;
  const k = Math.min(1, max / Math.max(cw, ch));
  const c = document.createElement("canvas"); c.width = Math.round(cw * k); c.height = Math.round(ch * k);
  const g = c.getContext("2d"); g.imageSmoothingQuality = "high";
  g.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, c.width, c.height);
  return c;
}
function grabFrame(max = 3200) {
  if (!cam.videoWidth) return null;
  return cropToView(cam, cam.videoWidth, cam.videoHeight, max);
}
// A real still photo at the camera's full resolution (sharper, uses autofocus) where the browser supports it.
let photoCaps = null;
async function grabPhoto() {
  const tr = track();
  try {
    if (!window.ImageCapture || !tr) throw 0;
    const ic = new ImageCapture(tr);
    let opts;
    try {
      if (!photoCaps || photoCaps.id !== tr.id) photoCaps = { id: tr.id, caps: await ic.getPhotoCapabilities() };
      const mw = photoCaps.caps?.imageWidth?.max;
      if (mw) opts = { imageWidth: Math.min(mw, 4032) };
    } catch (e) {}
    const shot = opts ? ic.takePhoto(opts).catch(() => ic.takePhoto()) : ic.takePhoto();
    const blob = await Promise.race([shot, new Promise((_, rej) => setTimeout(() => rej(0), 4500))]);
    const bm = await createImageBitmap(blob);
    // the photo must face the same way as the viewfinder; if it does not, use the video picture instead of guessing a rotation
    if (cam.videoWidth && (bm.width > bm.height) !== (cam.videoWidth > cam.videoHeight)) throw 0;
    return cropToView(bm, bm.width, bm.height, 3200);
  } catch (e) { return grabFrame(); }
}
function canvasFromImage(src, w, h) {
  const k = Math.min(1, 3200 / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function shrink(c, max) {
  const k = Math.min(1, max / Math.max(c.width, c.height));
  if (k === 1) return c;
  const t = document.createElement("canvas"); t.width = Math.round(c.width * k); t.height = Math.round(c.height * k);
  const g = t.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(c, 0, 0, t.width, t.height);
  return t;
}
const scaled = (c, max, q) => shrink(c, max).toDataURL("image/jpeg", q);
// show a full-resolution picture on screen (a blob URL is much lighter than a data URL)
function showPhoto(c) {
  return new Promise(res => {
    const old = photo.dataset.url;
    photo.onload = () => { if (old) URL.revokeObjectURL(old); res(); layoutOverlay(); };
    c.toBlob(b => {
      const url = b ? URL.createObjectURL(b) : "";
      photo.dataset.url = url;
      photo.src = url || c.toDataURL("image/jpeg", 0.9);
    }, "image/jpeg", 0.92);
  });
}
function flash() { const f = $("flash"); f.classList.remove("on"); void f.offsetWidth; if (!reduceMotion()) f.classList.add("on"); }
$("shutter").onclick = async () => {
  if (mode !== "live" || state.busy || shooting) return;
  shooting = true; flash();
  try {
    if (S.view === "overlay" && L.blocks.length && L.frame && !L.lost) { freezeLive(); return; }
    const c = await grabPhoto();
    if (!c) { toast("กล้องยังไม่พร้อมค่ะ รอสักครู่นะคะ"); return; }
    if (S.view === "overlay") overlayStill(c); else processCanvas(c);
  } finally { shooting = false; }
};
async function fromFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  try {
    let c;
    try { const bm = await createImageBitmap(file, { imageOrientation: "from-image" }); c = canvasFromImage(bm, bm.width, bm.height); }
    catch (e) {
      const url = URL.createObjectURL(file);
      const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      c = canvasFromImage(im, im.naturalWidth, im.naturalHeight); URL.revokeObjectURL(url);
    }
    if (S.view === "overlay") overlayStill(c); else processCanvas(c);
  } catch (e) { toast("เปิดรูปนี้ไม่ได้ค่ะ ลองรูปอื่นนะคะ"); }
}
$("pick").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; fromFile(f); });


/* ---------- motion watcher: auto capture (card mode) and live translation (overlay mode) ---------- */
const sCan = document.createElement("canvas"); sCan.width = 48; sCan.height = 64;
const sCtx = sCan.getContext("2d", { willReadFrequently: true });
let loopTimer = null, prevLum = null, stillSince = 0, armedAt = 0, movedAt = 0, LW = 48, LH = 64;
const live = { ctl: null };
// a tiny grey copy of the camera picture, same shape as the video
function lumNow() {
  const vw = cam.videoWidth, vh = cam.videoHeight;
  const W = 48, H = Math.max(27, Math.min(96, Math.round(48 * vh / vw)));
  if (sCan.width !== W || sCan.height !== H) { sCan.width = W; sCan.height = H; }
  LW = W; LH = H;
  sCtx.drawImage(cam, 0, 0, W, H);
  const d = sCtx.getImageData(0, 0, W, H).data, N = W * H, lum = new Float32Array(N);
  let edge = 0;
  for (let i = 0; i < N; i++) { lum[i] = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2]; if (i % W) edge += Math.abs(lum[i] - lum[i - 1]); }
  return { lum, edge: edge / N };
}
const lumDiff = (a, b) => { if (!a || !b || a.length !== b.length) return 99; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
function showStill(p) { $("still").hidden = !(p > 0); $("stillFg").style.strokeDashoffset = String(113.1 * (1 - p)); }
function startLoop() { stopLoop(); loopTimer = setInterval(tick, 110); }
function stopLoop() { clearInterval(loopTimer); loopTimer = null; prevLum = null; stillSince = 0; showStill(0); }
function tick() {
  if (mode !== "live" || !cam.videoWidth || panelStack.length || state.busy || shooting || camStarting || AL.testing || frameDragging || performance.now() < armedAt) { prevLum = null; stillSince = 0; return; }
  const { lum, edge } = lumNow();
  const diff = lumDiff(lum, prevLum); prevLum = lum;
  if (diff > 8) movedAt = performance.now();
  autoLensTick(diff < 3, edge);
  if (AL.testing) return;
  tickLive(lum, edge, diff);
}

/* ---------- live translation, like Google Lens: point at text and the translation is painted over it ---------- */
// L.ref = the small picture the current translation was made from; L.dx/L.dy = how far the view has slid since then
const L = { ref: null, frame: null, blocks: [], dx: 0, dy: 0, pendingRef: null, lost: false };
function resetLive() {
  live.ctl?.abort(); live.ctl = null; L.wctl?.abort(); L.wctl = null;
  Object.assign(L, { ref: null, frame: null, blocks: [], dx: 0, dy: 0, pendingRef: null, lost: false });
  const ov = $("ov"); ov.style.transform = ""; ov.classList.remove("lost");
}
// best whole-picture shift that lines the old picture up with the new one (with sub-cell precision)
function trackShift(cur, ref) {
  if (!cur || !ref || cur.length !== ref.length) return [0, 0, 99];
  const W = LW, H = LH, RX = 10, RY = Math.max(6, Math.round(H * 0.2)), SW = 2 * RX + 1;
  const E = new Float32Array(SW * (2 * RY + 1)).fill(1e9);
  let bi = -1, be = 1e9;
  for (let dy = -RY; dy <= RY; dy++) for (let dx = -RX; dx <= RX; dx++) {
    const y0 = Math.max(0, dy), y1 = Math.min(H, H + dy), x0 = Math.max(0, dx), x1 = Math.min(W, W + dx);
    if ((y1 - y0) * (x1 - x0) < W * H * 0.35) continue;
    let s = 0, n = 0;
    for (let y = y0; y < y1; y += 2) { const o = y * W, r = (y - dy) * W - dx; for (let x = x0; x < x1; x += 2) { s += Math.abs(cur[o + x] - ref[r + x]); n++; } }
    const e = s / n, idx = (dy + RY) * SW + dx + RX; E[idx] = e;
    if (e < be) { be = e; bi = idx; }
  }
  if (bi < 0) return [0, 0, 99];
  const bx = (bi % SW) - RX, by = Math.floor(bi / SW) - RY;
  const at = (x, y) => (x < -RX || x > RX || y < -RY || y > RY) ? 1e9 : E[(y + RY) * SW + x + RX];
  const sub = (a, b, c) => { const d = a - 2 * b + c; return d > 0 && a < 1e8 && c < 1e8 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d))) : 0; };
  return [bx + sub(at(bx - 1, by), be, at(bx + 1, by)), by + sub(at(bx, by - 1), be, at(bx, by + 1)), be];
}
function placeLive() {
  const vw = cam.videoWidth, vh = cam.videoHeight; if (!vw) return;
  const st = $("stage").getBoundingClientRect();
  const sc = Math.max(st.width / vw, st.height / vh) * (Z.hw ? 1 : Z.v);
  $("ov").style.transform = `translate(${(L.dx * vw / LW * sc).toFixed(1)}px,${(L.dy * vh / LH * sc).toFixed(1)}px)`;
}
function setLost(on) {
  if (L.lost === on) return;
  L.lost = on; $("ov").classList.toggle("lost", on);
  $("hint").hidden = !on && L.blocks.length > 0;
}
const TRACK_OK = 12;
function tickLive(lum, edge, diff) {
  const now = performance.now();
  if (S.view === "card" && (sheetState === "mid" || sheetState === "full")) return; // reading the card: hold it still
  let err = 99;
  if (L.ref) {
    const [dx, dy, e] = trackShift(lum, L.ref); err = e;
    if (e < TRACK_OK) { L.dx = dx; L.dy = dy; if (L.blocks.length) placeLive(); }
    setLost(e >= TRACK_OK);
  }
  if (diff >= 3) { stillSince = 0; return; }
  if (!stillSince) { stillSince = now; if (now - movedAt < 700) focusKick(); }
  if (now - stillSince < 280 || now - lastKick < 650) return;
  if (edge < 2.2) return; // nothing that looks like text (e.g. phone lying on the table)
  const shifted = Math.abs(L.dx) > LW * 0.12 || Math.abs(L.dy) > LH * 0.12; // new text has probably come into view
  if (L.ref && err < TRACK_OK && !shifted) return; // still the same view: keep the translation we have
  if (live.ctl) { // a translation is on its way: keep it unless the phone has since moved to something else
    if (trackShift(lum, L.pendingRef)[2] < TRACK_OK) return;
    live.ctl.abort(); live.ctl = null;
  }
  liveScan(lum);
}
function cropFrame(c) {
  if (S.view !== "card" || !S.frame) return c;
  const f = S.fr, x = Math.round(f.x * c.width), y = Math.round(f.y * c.height), w = Math.max(16, Math.round(f.w * c.width)), h = Math.max(16, Math.round(f.h * c.height));
  const t = document.createElement("canvas"); t.width = w; t.height = h;
  t.getContext("2d").drawImage(c, x, y, w, h, 0, 0, w, h);
  return t;
}
async function liveScan(lum) {
  const full = grabFrame(1280); if (!full) return;
  const c = cropFrame(full);
  const ctl = new AbortController(); live.ctl = ctl; L.pendingRef = lum; L.mute = false;
  if (!L.blocks.length || L.lost) liveChip("กำลังแปล…");
  const got = [];
  try {
    await scanBlocks(c, ctl.signal, b => {
      if (ctl.signal.aborted || mode !== "live") return;
      if (!got.length) { // the first piece of the new translation replaces the old one
        Object.assign(L, { ref: lum, frame: c, blocks: got, dx: 0, dy: 0 });
        trackNow();
      }
      paintColors(c, [b]); got.push(b);
      liveChip(""); $("hint").hidden = true;
      if (S.view === "overlay") { state.blocks = got; layoutOverlay(); } else if (!L.mute) liveCard(got);
    });
    if (ctl.signal.aborted || mode !== "live") return;
    if (got.length && S.view === "card" && !L.mute) liveWords(state.text);
    if (got.length && S.view === "overlay" && mode === "live") freezeLive(); // finished: hold this page
    if (!got.length) {
      Object.assign(L, { ref: lum, frame: c, blocks: [], dx: 0, dy: 0 }); state.blocks = []; layoutOverlay();
      liveChip("ยังไม่เจอข้อความ ลองส่องใกล้ขึ้นอีกนิดนะคะ"); setTimeout(() => { if (!L.blocks.length && !live.ctl) liveChip(""); }, 2200);
    }
  } catch (e) {
    if (ctl.signal.aborted) return;
    liveChip(""); toast(aiErr(e)); armedAt = performance.now() + 4000;
  } finally { if (live.ctl === ctl) live.ctl = null; }
}
// line the fresh translation up with where the camera is right now
function trackNow() {
  if (!prevLum) return;
  const [dx, dy, e] = trackShift(prevLum, L.ref);
  if (e < TRACK_OK) { L.dx = dx; L.dy = dy; }
  L.lost = !(e < TRACK_OK); $("ov").classList.toggle("lost", L.lost);
}
/* card mode, live: the card shows what the camera is pointing at; Save keeps it */
function cardReady(on) {
  const b = $("keepBtn"); b.disabled = !on;
  b.lastChild.textContent = on ? "บันทึก" : "กำลังแปล…";
}
const LIVE_SUB = "แปลเสร็จแล้วกดบันทึกได้เลยค่ะ", HOLD_SUB = "หยุดไว้ให้อ่าน · ปัดลงเพื่อส่องต่อ";
/* the reading frame (card mode) */
const FR_DEF = { x: 0.06, y: 0.18, w: 0.88, h: 0.3 };
if (!S.fr || !(S.fr.w > 0.1)) S.fr = { ...FR_DEF };
let frameDragging = false;
const isLand = () => matchMedia("(orientation:landscape) and (max-height:560px)").matches;
// the part of the screen the frame may use: below the top buttons, above the camera buttons and the card
function frameArea() {
  const st = $("stage").getBoundingClientRect(), W = st.width, H = st.height, top = insetPx("top");
  if (isLand()) {
    const colw = (parseFloat(getComputedStyle($("controls")).width) || 130), sheetW = Math.min(460, W * 0.52);
    // the frame may run under the card, but its left part (at least 120px) always stays out to grab
    return { x0: 64, x1: W - colw - 8, xMax: W - colw - sheetW - 120, y0: top + 58, y1: H - insetPx("bottom") - 104, W, H };
  }
  const ctrlTop = H - ($("controls").offsetHeight || 244), cardTop = H - Math.round(H * 0.42);
  return { x0: 10, x1: W - 10, y0: top + 116, y1: Math.min(ctrlTop, cardTop) - 10, W, H };
}
// keep the frame inside that area (in pixels), shrinking it if the area got smaller (e.g. after turning the phone)
function clampFrame(f, A) {
  const minW = 110, minH = 64;
  let w = Math.max(minW, Math.min(f.w * A.W, A.x1 - A.x0)), h = Math.max(minH, Math.min(f.h * A.H, A.y1 - A.y0));
  let x = Math.max(A.x0, Math.min(A.x1 - w, A.xMax ?? 1e9, f.x * A.W)), y = Math.max(A.y0, Math.min(A.y1 - h, f.y * A.H));
  return { x: x / A.W, y: y / A.H, w: w / A.W, h: h / A.H };
}
function paintFrame() {
  const on = mode === "live" && S.view === "card" && !!S.frame;
  const el = $("cropBox"), mask = $("cropMask"); el.hidden = !on; mask.hidden = !on;
  $("frameChip").textContent = S.frame ? "กรอบ: เปิด" : "กรอบ: ปิด"; $("frameChip").setAttribute("aria-pressed", String(!!S.frame));
  if (!on) return;
  const A = frameArea();
  if (!frameDragging) S.fr = clampFrame(S.fr, A);
  const x = S.fr.x * A.W, y = S.fr.y * A.H, w = S.fr.w * A.W, h = S.fr.h * A.H;
  el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  // the darkened area outside the frame: four plain rectangles (much cheaper to move than a giant shadow)
  const [t, b, l, r] = mask.children;
  t.style.cssText = `left:0;top:0;right:0;height:${y}px`;
  b.style.cssText = `left:0;top:${y + h}px;right:0;bottom:0`;
  l.style.cssText = `left:0;top:${y}px;width:${x}px;height:${h}px`;
  r.style.cssText = `left:${x + w}px;top:${y}px;right:0;height:${h}px`;
}
window.addEventListener("resize", () => paintFrame());
$("frameChip").onclick = e => { e.stopPropagation(); S.frame = !S.frame; saveSettings(); paintFrame(); resetLive(); state.text = ""; sheetTo("away"); toast(S.frame ? "อ่านเฉพาะในกรอบค่ะ ลากกรอบเพื่อย้าย ลากขอบหรือมุมเพื่อปรับขนาด" : "อ่านทั้งจอค่ะ"); };
(() => {
  const el = $("cropBox"); let drag = null, raf = 0, last = null;
  const EDGE = 30; // a finger within this distance of the frame's edge resizes; further inside moves it
  el.addEventListener("pointerdown", e => {
    e.stopPropagation(); e.preventDefault();
    const r = el.getBoundingClientRect(), lx = e.clientX - r.left, ly = e.clientY - r.top;
    let h = "";
    if (ly < EDGE) h += "n"; else if (ly > r.height - EDGE) h += "s";
    if (lx < EDGE) h += "w"; else if (lx > r.width - EDGE) h += "e";
    const A = frameArea();
    drag = { h: h || "move", x: e.clientX, y: e.clientY, A, px: { x: S.fr.x * A.W, y: S.fr.y * A.H, w: S.fr.w * A.W, h: S.fr.h * A.H } };
    frameDragging = true; el.setPointerCapture(e.pointerId); el.classList.add("drag"); el.dataset.h = drag.h;
  });
  const apply = () => {
    raf = 0; if (!drag || !last) return;
    const { A, px } = drag, dx = last.x - drag.x, dy = last.y - drag.y, minW = 110, minH = 64;
    let { x, y, w, h } = px;
    if (drag.h === "move") { x = Math.max(A.x0, Math.min(A.x1 - w, A.xMax ?? 1e9, x + dx)); y = Math.max(A.y0, Math.min(A.y1 - h, y + dy)); }
    else {
      if (drag.h.includes("w")) { const nx = Math.max(A.x0, Math.min(x + w - minW, A.xMax ?? 1e9, x + dx)); w += x - nx; x = nx; }
      if (drag.h.includes("e")) w = Math.max(minW, Math.min(A.x1 - x, w + dx));
      if (drag.h.includes("n")) { const ny = Math.max(A.y0, Math.min(y + h - minH, y + dy)); h += y - ny; y = ny; }
      if (drag.h.includes("s")) h = Math.max(minH, Math.min(A.y1 - y, h + dy));
    }
    S.fr = { x: x / A.W, y: y / A.H, w: w / A.W, h: h / A.H }; paintFrame();
  };
  el.addEventListener("pointermove", e => { if (!drag) return; last = { x: e.clientX, y: e.clientY }; if (!raf) raf = requestAnimationFrame(apply); });
  const end = () => {
    if (!drag) return; if (raf) { cancelAnimationFrame(raf); apply(); }
    drag = null; last = null; frameDragging = false; el.classList.remove("drag"); delete el.dataset.h;
    saveSettings(); paintFrame(); resetLive(); // read the new area
  };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
  ["click", "touchstart", "touchmove"].forEach(t => el.addEventListener(t, e => e.stopPropagation(), { passive: true }));
})();
function liveCard(blocks) {
  state.text = blocks.map(b => b.text).join("\n"); state.tr = blocks.map(b => b.tr).join("\n"); state.words = []; state.blocks = [];
  showErr(""); setEditing(false); $("editBtn").hidden = true; $("goRow").hidden = true;
  resHead(autoTitle(state.text), LIVE_SUB); cardReady(false);
  renderSrcView(); $("trText").textContent = state.tr; $("trSt").textContent = "";
  $("wordsBox").hidden = true; $("words").innerHTML = "";
  if (sheetState === "away") sheetTo("peek");
}
async function liveWords(text) {
  L.wctl?.abort(); const ctl = new AbortController(); L.wctl = ctl;
  $("wSt").textContent = " · ตั้งแต่ " + S.lv;
  const key = ["W", text, S.tgt, S.lv].join("\u0001");
  const apply = (words, done) => { if (state.text !== text) return; state.words = words; renderSrcView(); renderWords(words, done); };
  if (memo.has(key)) { apply(memo.get(key), true); cardReady(true); return; }
  apply([], false);
  const prompt = `You help a learner read foreign-language text. List its difficult vocabulary.
Text:
"""
${text}
"""
Reply in exactly this format and nothing else:
${wordsRules(S.tgt)}`;
  try {
    const out = await streamText([prompt], t => { if (!ctl.signal.aborted) apply(parseOut(t).words.filter(w => w._ok), false); }, ctl.signal);
    if (ctl.signal.aborted) return;
    const words = parseOut(out).words.map(({ _ok, ...w }) => w);
    remember(key, words); apply(words, true);
    if (state.text === text) cardReady(true);
  } catch (e) { if (!ctl.signal.aborted && state.text === text) { renderWords([], true); cardReady(true); } }
  finally { if (L.wctl === ctl) L.wctl = null; }
}
function saveCard() {
  if (mode !== "live" || !L.frame || !state.text || $("keepBtn").disabled) return;
  const c = L.frame;
  Object.assign(state, { thumb: scaled(c, 320, 0.6), img: scaled(c, 1280, 0.72), pageId: null, pageArticle: null, pageNo: 0 });
  setLastThumb(state.thumb, true);
  const no = savePage();
  toast(no ? `บันทึกแล้วค่ะ · ${cur.title || "บทความ"} หน้า ${no}` : "บันทึกไม่สำเร็จค่ะ");
  // done: put the card away until the camera points at something new
  L.mute = true; L.wctl = null; sheetTo("away"); $("hint").hidden = false;
}
function freezeCard() {
  const c = L.frame; // already just the part inside the frame
  live.ctl?.abort(); live.ctl = null;
  Object.assign(L, { ref: null, frame: null, blocks: [], dx: 0, dy: 0, pendingRef: null, lost: false });
  photo.removeAttribute("src"); setFrozen(); showPhoto(c);
  Object.assign(state, { thumb: scaled(c, 320, 0.6), img: scaled(c, 1280, 0.72), pageId: null, pageArticle: null, pageNo: 0 });
  setLastThumb(state.thumb, true);
  const no = savePage();
  resHead(cur.id ? cur.title : autoTitle(state.text), no ? `หน้า ${no} · เก็บไว้ในบทความแล้วค่ะ` : "");
  $("editBtn").hidden = false; sheetTo("mid");
}
// shutter in overlay mode: keep what is on screen (picture + translation), save it, and offer to save it to the phone
function freezeLive() {
  const c = L.frame, blocks = L.blocks.map(b => ({ ...b, off: false }));
  resetLive();
  state.canvas = c; state.blocks = blocks; state.showOrig = false;
  $("ov").classList.remove("orig"); paintOrigBtn();
  photo.removeAttribute("src"); setFrozen(); $("freezeX").hidden = false;
  showPhoto(c); $("ovBar").hidden = false;
}

function liveChip(t) { const el = $("liveChip"); el.textContent = t; el.hidden = !t; }
const OV_SCHEMA = { type: "array", items: { type: "object", properties: { box: { type: "array", items: { type: "integer" } }, text: { type: "string" }, tr: { type: "string" },
  rot: { type: "integer" }, italic: { type: "boolean" }, bold: { type: "boolean" } }, required: ["box", "text", "tr"] } };
function ovPrompt() {
  const src = S.src === "auto" ? "foreign-language (most likely English)" : S.src;
  return `This photo was taken with a phone, often of a computer or phone screen (expect glare, moiré, tilt).
Find every block of ${src} text in it: headings, paragraphs, captions, buttons, speech bubbles. Skip text that is already in ${S.tgt}.
For each block return:
- box: [ymin, xmin, ymax, xmax] tightly around the whole block, integers normalized 0-1000 of the image height and width
- text: the block's text exactly as written
- tr: a natural, fluent ${S.tgt} translation${S.view === "overlay" ? ", short enough to fit in the same space" : ""}
- rot: how the lines of text are turned in the photo, degrees clockwise: 0 normal, 90 turned clockwise (reads top to bottom), -90 turned counter-clockwise (reads bottom to top), 180 upside down
- italic: true if the letters are italic (slanted); bold: true if they are bold
Order the blocks in reading order. Return [] if there is no such text.`;
}
function normBlock(b) {
  if (!b || !Array.isArray(b.box) || b.box.length !== 4 || !b.tr) return null;
  let [y0, x0, y1, x1] = b.box.map(v => Math.max(0, Math.min(1000, Number(v) || 0)));
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 - y0 < 4 || x1 - x0 < 4) return null;
  const q = Math.round((Number(b.rot) || 0) / 90), rot = [0, 90, 180, -90][((q % 4) + 4) % 4];
  return { box: [y0, x0, y1, x1], text: String(b.text || ""), tr: String(b.tr || ""), rot, italic: !!b.italic, bold: !!b.bold };
}
// Gemini streams the JSON; each block is shown the moment it is complete instead of waiting for the whole answer
// measured from Thailand: gemini-3.5-flash shows the first box in ~1.7 s, flash-lite in 2-5 s; lite is the fallback if the free quota runs out
let ovModel = MODELS.accurate;
async function scanBlocks(canvas, signal, onBlock) {
  const m = getGenerativeModel(ai, { model: ovModel, generationConfig: {
    responseMimeType: "application/json", responseJsonSchema: OV_SCHEMA, ...(noThink ? {} : { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }) } });
  const data = shrink(canvas, 1280).toDataURL("image/jpeg", 0.8).split(",")[1];
  let res;
  try { res = await m.generateContentStream([ovPrompt(), { inlineData: { data, mimeType: "image/jpeg" } }], { signal }); }
  catch (e) {
    if (!signal.aborted && !noThink && /thinking/i.test(String(e?.message))) { noThink = true; return scanBlocks(canvas, signal, onBlock); }
    if (!signal.aborted && ovModel !== MODELS.fast && /429|quota|exhaust|rate/i.test(String(e?.message))) { ovModel = MODELS.fast; return scanBlocks(canvas, signal, onBlock); }
    throw e;
  }
  const out = [];
  let buf = "", pos = 0, depth = 0, inStr = false, escp = false, start = -1;
  for await (const ch of res.stream) {
    if (signal.aborted) return out;
    let t = ""; try { t = ch.text(); } catch (e) {}
    buf += t;
    for (; pos < buf.length; pos++) {
      const k = buf[pos];
      if (inStr) { if (escp) escp = false; else if (k === "\\") escp = true; else if (k === '"') inStr = false; continue; }
      if (k === '"') inStr = true;
      else if (k === "{") { if (depth === 1) start = pos; depth++; }
      else if (k === "}") { depth--; if (depth === 1 && start >= 0) { let b = null; try { b = normBlock(JSON.parse(buf.slice(start, pos + 1))); } catch (e) {} start = -1; if (b) { out.push(b); if (onBlock) onBlock(b); } } }
      else if (k === "[") depth++;
      else if (k === "]") depth--;
    }
  }
  return out;
}
async function overlayStill(c) {
  abortAll(); live.ctl?.abort();
  state.canvas = c; state.blocks = []; state.showOrig = false;
  $("ov").hidden = true; $("ov").innerHTML = ""; $("ov").classList.remove("orig"); $("ovBar").hidden = true; paintOrigBtn();
  photo.removeAttribute("src"); setFrozen(); $("freezeX").hidden = false;
  showPhoto(c);
  liveChip("กำลังแปล…");
  const ctl = new AbortController(); live.ctl = ctl;
  const t0 = performance.now();
  try {
    const blocks = await scanBlocks(c, ctl.signal);
    if (ctl.signal.aborted || mode !== "frozen") return;
    paintColors(c, blocks); state.blocks = blocks;
    liveChip(blocks.length ? "" : "ไม่เจอข้อความในภาพนี้ค่ะ ลองถ่ายใกล้ขึ้นนะคะ");
    layoutOverlay(); $("ovBar").hidden = !blocks.length;
    if (blocks.length) toast("แปลเสร็จใน " + secs(performance.now() - t0) + " วินาที");
  } catch (e) { if (!ctl.signal.aborted) { liveChip(""); toast(aiErr(e)); } }
  finally { if (live.ctl === ctl) live.ctl = null; }
}
// Match each translation box to the picture: background = the colour around the text, text = the colour of the letters.
const sampleCache = new WeakMap();
// angle of the lines of text inside a box: the rotation at which the letters stack into the sharpest rows
function textAngle(smp, L, R, T, B, bg, base = 0) {
  const { W, H, d } = smp;
  const x0 = Math.max(0, Math.floor(L)), x1 = Math.min(W - 1, Math.ceil(R)), y0 = Math.max(0, Math.floor(T)), y1 = Math.min(H - 1, Math.ceil(B));
  if (x1 - x0 < 24 || y1 - y0 < 8) return base;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const step = Math.max(1, Math.round(Math.sqrt((x1 - x0) * (y1 - y0) / 7000)));
  const px = [], py = [];
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
    const i = (y * W + x) * 4;
    if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 90) { px.push(x - cx); py.push(y - cy); }
  }
  if (px.length < 40) return base;
  const span = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 2, bins = new Float32Array(span * 2 + 1);
  const score = a => {
    const sn = Math.sin(a), cs = Math.cos(a); bins.fill(0);
    for (let k = 0; k < px.length; k++) bins[Math.round(py[k] * cs - px[k] * sn) + span]++;
    let s = 0; for (let k = 0; k < bins.length; k++) s += bins[k] * bins[k]; return s;
  };
  const deg = Math.PI / 180, s0 = score(base * deg);
  let best = base, bs = s0;
  for (let a = base - 20; a <= base + 20; a += 1.5) { const v = score(a * deg); if (v > bs) { bs = v; best = a; } }
  for (let a = best - 1.5; a <= best + 1.5; a += 0.25) { const v = score(a * deg); if (v > bs) { bs = v; best = a; } }
  return Math.abs(best - base) >= 1.5 && bs > s0 * 1.1 ? best : base; // degrees, clockwise
}
function paintColors(c, blocks) {
  let smp = sampleCache.get(c);
  if (!smp) {
    const k = Math.min(1, 900 / Math.max(c.width, c.height));
    const W0 = Math.max(1, Math.round(c.width * k)), H0 = Math.max(1, Math.round(c.height * k));
    const t = document.createElement("canvas"); t.width = W0; t.height = H0;
    const g = t.getContext("2d", { willReadFrequently: true }); g.drawImage(c, 0, 0, W0, H0);
    smp = { W: W0, H: H0, d: g.getImageData(0, 0, W0, H0).data }; sampleCache.set(c, smp);
  }
  const { W, H, d } = smp;
  const px = (x, y) => { x = Math.max(0, Math.min(W - 1, Math.round(x))); y = Math.max(0, Math.min(H - 1, Math.round(y))); const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const lumOf = p => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  const relL = p => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]); };
  const contrast = (a, b) => { const x = relL(a), y = relL(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const rgb = p => `rgb(${p.map(v => Math.round(v)).join(",")})`;
  for (const b of blocks) {
    const [y0, x0, y1, x1] = b.box;
    const L = x0 / 1000 * W, R = x1 / 1000 * W, T = y0 / 1000 * H, B = y1 / 1000 * H;
    const ring = [], sx = Math.max(1, (R - L) / 24), sy = Math.max(1, (B - T) / 10);
    for (let x = L; x <= R; x += sx) ring.push(px(x, T - 2), px(x, T + 1), px(x, B - 1), px(x, B + 2));
    for (let y = T; y <= B; y += sy) ring.push(px(L - 2, y), px(L + 1, y), px(R - 1, y), px(R + 2, y));
    ring.sort((a, b2) => lumOf(a) - lumOf(b2));
    const bg = ring[Math.floor(ring.length / 2)] || [255, 255, 255];
    // the letters: the pixels inside the box that differ most from the background
    const inside = [], ix = Math.max(1, (R - L) / 40), iy = Math.max(1, (B - T) / 14);
    for (let y = T + 1; y < B - 1; y += iy) for (let x = L + 1; x < R - 1; x += ix) {
      const p = px(x, y); inside.push([Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]), p]);
    }
    inside.sort((a, b2) => b2[0] - a[0]);
    const top = inside.slice(0, Math.max(1, Math.floor(inside.length * 0.05)));
    let fg = top.length && top[0][0] > 60 ? [0, 1, 2].map(j => top.reduce((s, q) => s + q[1][j], 0) / top.length) : null;
    if (!fg || contrast(fg, bg) < 3) fg = relL(bg) > 0.4 ? [17, 17, 24] : [255, 255, 255];
    b.bg = rgb(bg); b.fg = rgb(fg);
    b.ang = textAngle(smp, L, R, T, B, bg, b.rot || 0);
  }
}
function paintOrigBtn() { $("ovOrig").textContent = state.showOrig ? "ดูคำแปล" : "ดูต้นฉบับ"; $("ovOrig").setAttribute("aria-pressed", String(!!state.showOrig)); }
$("ovOrig").onclick = () => { state.showOrig = !state.showOrig; $("ov").classList.toggle("orig", state.showOrig); paintOrigBtn(); };
$("ovCopy").onclick = async () => {
  const t = state.blocks.map(b => b.tr).join("\n");
  try { await navigator.clipboard.writeText(t); toast("คัดลอกคำแปลแล้วค่ะ"); } catch (e) { toast("คัดลอกไม่ได้ค่ะ"); }
};
// Save: the translated picture goes to the phone and into the articles, then back to the camera
$("ovSave").onclick = async () => {
  if ($("ovSave").disabled || !state.canvas) return;
  const c = state.canvas;
  const ok = await saveToDevice();
  if (!ok) return;
  saveOverlayPage(c);
  goLive();
};
function saveOverlayPage(c) {
  if (!state.blocks.length) return;
  Object.assign(state, { text: state.blocks.map(b => b.text).join("\n"), tr: state.blocks.map(b => b.tr).join("\n"), words: [],
    thumb: scaled(c, 320, 0.6), img: scaled(c, 1280, 0.72), pageId: null, pageArticle: null, pageNo: 0 });
  setLastThumb(state.thumb, true);
  savePage();
}

/* ---------- save the translated picture to the phone ---------- */
const segmenter = window.Intl && Intl.Segmenter ? new Intl.Segmenter("th", { granularity: "word" }) : null;
function wrapLines(g, text, maxW) {
  const out = [];
  for (const para of String(text).split("\n")) {
    const parts = segmenter ? [...segmenter.segment(para)].map(s => s.segment) : para.split(/(\s+)/);
    let line = "";
    for (const p of parts) {
      if (g.measureText(line + p).width <= maxW) { line += p; continue; }
      if (line.trim()) { out.push(line.trimEnd()); line = p.trimStart(); }
      else line = p;
      // a single piece wider than the box: break it by letters
      while (g.measureText(line).width > maxW && line.length > 1) {
        let i = 1; while (i < line.length && g.measureText(line.slice(0, i + 1)).width <= maxW) i++;
        out.push(line.slice(0, i)); line = line.slice(i);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
async function renderOverlayImage() {
  const c = state.canvas; if (!c) return null;
  try { await Promise.all([document.fonts.load('600 20px "Sarabun"'), document.fonts.load('italic 600 20px "Sarabun"')]); } catch (e) {}
  const W = c.width, H = c.height;
  const out = document.createElement("canvas"); out.width = W; out.height = H;
  const g = out.getContext("2d"); g.drawImage(c, 0, 0);
  if (!state.showOrig) {
    const ovW = parseFloat($("ov").style.width) || W;
    const k = W / ovW;
    const canBlur = "filter" in g;
    for (const b of state.blocks) {
      if (b.off || b.dup) continue;
      const gm = boxGeom(b, W, H), w = gm.w, h = Math.max(gm.h, (b.hpx || 0) * k), rad = gm.a * Math.PI / 180;
      g.save(); g.translate(gm.cx, gm.cy); g.rotate(rad);
      // frosted glass: blur what is underneath, then a milky layer in the background colour
      g.save(); g.beginPath(); g.rect(-w / 2 - 2 * k, -h / 2 - 2 * k, w + 4 * k, h + 4 * k); g.clip();
      if (canBlur) { g.rotate(-rad); g.translate(-gm.cx, -gm.cy); g.filter = `blur(${6 * k}px)`; g.drawImage(c, 0, 0); g.filter = "none"; }
      g.restore();
      g.globalAlpha = canBlur ? 0.78 : 0.9; g.fillStyle = b.bg; g.shadowColor = b.bg; g.shadowBlur = 6 * k;
      g.fillRect(-w / 2, -h / 2, w, h); g.globalAlpha = 1; g.shadowBlur = 0;
      const fs = (b.fs || 14) * k, pad = 3 * k, lh = fs * 1.22;
      g.font = `${b.italic ? "italic " : ""}${b.bold ? 700 : 600} ${fs}px "Sarabun", system-ui, sans-serif`; g.fillStyle = b.fg; g.textBaseline = "top";
      const lines = wrapLines(g, b.tr, w - pad * 2);
      let ty = -h / 2 + Math.max(0, (h - lines.length * lh) / 2) + (lh - fs) / 2;
      for (const ln of lines) { g.fillText(ln, -w / 2 + pad, ty); ty += lh; }
      g.restore();
    }
  }
  return new Promise(res => out.toBlob(res, "image/jpeg", 0.92));
}
async function saveToDevice() {
  const btn = $("ovSave"); if (btn.disabled) return;
  btn.disabled = true;
  try {
    const blob = await renderOverlayImage();
    if (!blob) { toast("ยังไม่มีรูปให้บันทึกค่ะ"); return false; }
    const name = "lumi-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".jpg";
    const file = new File([blob], name, { type: "image/jpeg" });
    if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); toast("บันทึกแล้วค่ะ"); return true; } catch (e) { if (e && e.name === "AbortError") return false; }
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("บันทึกแล้วค่ะ รูปอยู่ในอัลบั้ม Download และในบทความนะคะ");
    return true;
  } catch (e) { toast("บันทึกรูปไม่สำเร็จค่ะ"); return false; }
  finally { btn.disabled = false; }
}

/* ================= read text (OCR) ================= */
function abortAll() { state.ocrCtl?.abort(); state.trCtl?.abort(); state.busy = false; }
function resHead(title, sub) { $("resTitle").textContent = title; $("resSub").textContent = sub || ""; }
async function processCanvas(c) {
  abortAll();
  const dataUrl = scaled(c, 2048, 0.85);
  photo.removeAttribute("src"); setFrozen(); showPhoto(c);
  Object.assign(state, { text: "", words: [], tr: "", blocks: [], canvas: null, thumb: scaled(c, 320, 0.6), img: scaled(c, 1280, 0.72), pageId: null, pageArticle: null, pageNo: 0 });
  setLastThumb(state.thumb, true);
  $("ov").hidden = true; $("ov").innerHTML = "";
  showErr(""); setEditing(false); $("editBtn").hidden = true; $("goRow").hidden = true;
  resHead("กำลังอ่านข้อความ…", "");
  $("srcView").innerHTML = `<span class="ph-t dots">กำลังอ่านข้อความในภาพ</span>`;
  $("trText").innerHTML = `<span class="ph-t">${S.auto ? "อ่านเสร็จแล้วจะแปลให้ทันทีค่ะ" : "อ่านเสร็จแล้วตรวจข้อความได้ก่อนกดแปลนะคะ"}</span>`;
  $("words").innerHTML = ""; $("trSt").textContent = ""; $("wSt").textContent = ""; $("wordsBox").hidden = true;
  $("goTr").disabled = true; $("scan").hidden = false;
  sheetTo("mid");
  if (!navigator.onLine) { $("scan").hidden = true; $("srcView").textContent = ""; showErr("ไม่มีอินเทอร์เน็ตค่ะ ต่อเน็ตแล้วถ่ายใหม่นะคะ"); resHead("ยังไม่ได้อ่าน"); sheetTo("mid"); return; }

  const srcName = S.src === "auto" ? "main language (most likely English)" : S.src;
  const withBoxes = false;
  const prompt = withBoxes ?
`You are the text reader inside a camera-translation app. The photo was taken with a phone, often pointed at a computer or phone screen, so expect moiré, glare, blur and tilt.
Task: find the ${srcName} text in the photo and transcribe it exactly as written, grouped into blocks (a paragraph, heading, caption, list item, or speech bubble).
Output one line per block, top to bottom, in this exact form:
[ymin, xmin, ymax, xmax] block text
- The box tightly encloses the whole block. Coordinates are integers normalized to 0–1000 of the image height (y) and width (x).
- Re-join words hyphenated across lines and the lines of one block into a single line of text.
- Skip interface clutter such as menus, buttons, URLs, timestamps and ads unless it is the only text.
- Keep the original spelling, punctuation and capitalization. Do not translate, correct or explain.
- If the photo has no such text, reply exactly: NO_TEXT` :
`You are the text reader inside a camera-translation app. The photo was taken with a phone, often pointed at a computer or phone screen, so expect moiré, glare, blur and tilt.
Task: transcribe the ${srcName} text in the photo exactly as written.
Rules:
- Transcribe the main readable content (article, captions, dialogue, questions). Skip interface clutter such as menus, buttons, URLs, timestamps and ads unless it is the only text.
- Re-join words hyphenated across lines and lines that belong to the same sentence. Put each paragraph on its own line.
- Keep the original spelling, punctuation and capitalization. Do not translate, correct, explain or add anything.
- If a word is hard to read, write your best guess.
- If the photo has no such text, reply exactly: NO_TEXT
Reply with the transcription only.`;
  const ctl = new AbortController(); state.ocrCtl = ctl; state.busy = true;
  const t0 = performance.now();
  try {
    const raw = await streamText([prompt, { inlineData: { data: dataUrl.split(",")[1], mimeType: "image/jpeg" } }],
      t => { if (ctl.signal.aborted) return; $("scan").hidden = true; $("srcView").textContent = t; }, ctl.signal);
    if (ctl.signal.aborted) return;
    state.busy = false; $("scan").hidden = true;
    const clean = raw.trim();
    if (!clean || clean === "NO_TEXT") { $("srcView").textContent = ""; showErr("ไม่เจอข้อความในภาพค่ะ ลองถ่ายใกล้ขึ้นอีกนิดนะคะ"); resHead("ไม่เจอข้อความ"); sheetTo("mid"); return; }
    state.text = clean; renderSrcView();
    resHead(cur.id ? cur.title : autoTitle(clean), "อ่านเสร็จใน " + secs(performance.now() - t0) + " วินาที");
    $("editBtn").hidden = false; $("goTr").disabled = false; $("goRow").hidden = S.auto;
    if (S.auto) translate(); else { sheetTo("mid"); setEditing(true); }
  } catch (e) {
    if (ctl.signal.aborted) return;
    state.busy = false; $("scan").hidden = true; $("srcView").textContent = ""; showErr(aiErr(e)); resHead("อ่านข้อความไม่สำเร็จ"); sheetTo("mid");
  }
}

/* ================= edit ================= */
function setEditing(on) {
  $("srcEdit").hidden = !on; $("srcView").hidden = on;
  $("editBtn").textContent = on ? "เสร็จ" : "แก้ไข";
  if (on) $("srcEdit").value = state.text;
}
function commitEdit() {
  const v = $("srcEdit").value.trim();
  if (v !== state.text) {
    state.text = v; state.words = [];
    const lines = v.split("\n");
    if (state.blocks.length && lines.length === state.blocks.length) state.blocks.forEach((b, i) => { b.text = lines[i].trim(); b.tr = ""; });
    else if (state.blocks.length) { state.blocks = []; $("ov").hidden = true; toast("จำนวนบรรทัดเปลี่ยน รอบนี้แสดงแบบการ์ดนะคะ"); }
  }
  $("goTr").disabled = !state.text || state.busy;
}
$("editBtn").onclick = () => {
  if ($("srcEdit").hidden) { setEditing(true); $("goRow").hidden = false; sheetTo("mid"); $("srcEdit").focus(); return; }
  commitEdit(); setEditing(false); renderSrcView();
};
$("srcEdit").addEventListener("input", () => { $("goTr").disabled = !$("srcEdit").value.trim() || state.busy; });

/* ================= render ================= */
function markText(t, words) {
  const low = t.toLowerCase(), ranges = [];
  words.forEach((w, i) => {
    const p = String(w.word || "").toLowerCase().trim(); if (!p) return;
    let from = 0;
    for (;;) {
      const k = low.indexOf(p, from); if (k < 0) break;
      const okB = k === 0 || !/[\p{L}\p{N}]/u.test(t[k - 1]);
      const okA = k + p.length >= t.length || !/[\p{L}\p{N}]/u.test(t[k + p.length]);
      if (okB && okA && !ranges.some(r => k < r.e && k + p.length > r.s)) { ranges.push({ s: k, e: k + p.length, i, r: rarity(w.lv) }); break; }
      from = k + 1;
    }
  });
  ranges.sort((a, b) => a.s - b.s);
  let html = "", pos = 0;
  for (const r of ranges) { html += esc(t.slice(pos, r.s)) + `<mark class="L${r.r}" data-i="${r.i}">` + esc(t.slice(r.s, r.e)) + "</mark>"; pos = r.e; }
  return html + esc(t.slice(pos));
}
function renderSrcView() { $("srcView").innerHTML = state.text ? markText(state.text, state.words) : ""; }
function wordCard(w, i, prefix) {
  const lv = LEVELS.includes(w.lv) ? w.lv : "B2";
  return `<div class="w L${rarity(lv)}" id="${prefix}${i}"><span class="lv">${lv}</span><div>`
    + `<span class="ww">${esc(w.word)}</span><span class="ipa">${esc(w.ipa)}</span>`
    + (w.pos ? `<div class="pos">${esc(POS[w.pos] || w.pos)}</div>` : "")
    + `<div class="m">${esc(w.mean)}</div>`
    + (w.ctx ? `<div class="c">ในประโยคนี้: ${esc(w.ctx)}</div>` : "") + `</div></div>`;
}
function jumpToWord(container, prefix, onSheet) {
  container.addEventListener("click", e => {
    const m = e.target.closest("mark"); if (!m) return;
    const card = $(prefix + m.dataset.i); if (!card) return;
    if (onSheet) sheetTo("full");
    card.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
    card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1200);
  });
}
jumpToWord($("srcView"), "w", true);
function renderWords(list, done) {
  $("wordsBox").hidden = false;
  const box = $("words");
  if (!list.length) {
    box.innerHTML = done ? `<div class="card ph-t">ข้อความนี้ไม่มีคำระดับ ${S.lv} ขึ้นไปค่ะ อ่านสบาย ๆ เลย</div>` : `<div class="ph-t dots">กำลังเลือกคำยาก</div>`;
    return;
  }
  box.innerHTML = list.map((w, i) => wordCard(w, i, "w")).join("") + (done ? "" : `<div class="ph-t dots">กำลังเพิ่มคำ</div>`);
}

/* ================= translate ================= */
$("goTr").onclick = () => { if (!$("srcEdit").hidden) { commitEdit(); setEditing(false); } translate(); };
function parseOut(t) {
  const iT = t.indexOf("### TRANSLATION"), iW = t.indexOf("### WORDS");
  const tr = iT >= 0 ? t.slice(iT + 15, iW >= 0 ? iW : undefined) : (iW >= 0 ? t.slice(0, iW) : "");
  const words = [];
  if (iW >= 0) {
    for (const line of t.slice(iW + 9).split("\n")) {
      const f = line.split("|").map(s => s.trim().replace(/^[-*•]\s*/, ""));
      if (f.length < 5 || !f[0] || /^(word|item)$/i.test(f[0])) continue;
      words.push({ word: f[0], ipa: f[1], pos: f[2], lv: (f[3] || "").toUpperCase().slice(0, 2), mean: f[4], ctx: f[5] || "", _ok: f.length >= 6 });
    }
  }
  return { tr: tr.trim(), words, wordsStarted: iW >= 0 };
}
function wordsRules(tgt) {
  const lvIdx = LEVELS.indexOf(S.lv);
  return `### WORDS
<one line per difficult item, in order of appearance>
item as written in the text | IPA of its base form | part of speech (n., v., adj., adv., phr. v., idiom) | CEFR level | short meaning in ${tgt} | what it means in this sentence, in ${tgt}

Rules for WORDS:
- Only words, phrasal verbs and idioms that appear in the text at CEFR ${S.lv} or above (${LEVELS.slice(lvIdx).join(", ")}). Skip names.
- Copy the item exactly as it appears in the text (keep its inflection) so it can be found in the text.
- At most 12 lines. If nothing qualifies, write NONE under the heading.
- Use | only as the column separator.`;
}
function parseOverlay(t) {
  const iB = t.indexOf("### BLOCKS"), iW = t.indexOf("### WORDS");
  const map = {};
  if (iB >= 0) for (const line of t.slice(iB + 10, iW >= 0 ? iW : undefined).split("\n")) {
    const m = line.match(/^\s*\[?(\d+)\]?\s*[|:.)\-]\s*(.+)$/); if (m) map[+m[1]] = m[2].trim();
  }
  const w = parseOut(iW >= 0 ? t.slice(iW) : "");
  return { map, words: w.words, wordsStarted: iW >= 0 };
}
function applyResult(tr, words, done, wordsStarted) {
  state.tr = tr; state.words = words;
  if (tr) $("trText").textContent = tr;
  renderSrcView();
  if (done || wordsStarted) renderWords(words, done);
}
async function translate() {
  const text = state.text.trim(); if (!text) return;
  showErr("");
  const ov = false;
  const tgt = S.tgt;
  const key = [text, tgt, S.lv, ov ? "ov" : ""].join("\u0001");
  $("wSt").textContent = " · ตั้งแต่ " + S.lv;
  if (memo.has(key)) {
    const r = memo.get(key);
    if (ov && r.btr) state.blocks.forEach((b, i) => { b.tr = r.btr[i] || ""; });
    applyResult(r.tr, r.words, true); $("trSt").textContent = "จากที่เคยแปล";
    afterTranslate(ov, "แปลจากที่เคยแปลไว้"); return;
  }
  if (!navigator.onLine) { showErr("ไม่มีอินเทอร์เน็ตค่ะ ต่อเน็ตแล้วกดแปลใหม่นะคะ"); return; }
  state.trCtl?.abort();
  const ctl = new AbortController(); state.trCtl = ctl;
  const t0 = performance.now(); state.busy = true; $("goTr").disabled = true;
  $("trText").innerHTML = `<span class="ph-t dots">กำลังแปล</span>`; $("words").innerHTML = ""; $("wordsBox").hidden = true; $("trSt").textContent = "";
  const prompt = ov ?
`You help a learner read foreign-language text from a photo. Translate each numbered block into ${tgt} and explain the difficult vocabulary.
Blocks:
${state.blocks.map((b, i) => `[${i + 1}] ${b.text}`).join("\n")}
Reply in exactly this format and nothing else:
### BLOCKS
1 | <natural, fluent ${tgt} translation of block 1, concise enough to fit where the original text was>
2 | <translation of block 2>
(one line per block, same numbering)
${wordsRules(tgt)}` :
`You help a learner read foreign-language text. Translate it into ${tgt} and explain its difficult vocabulary.
Text:
"""
${text}
"""
Reply in exactly this format and nothing else:
### TRANSLATION
<a natural, fluent ${tgt} translation that reads like a native writer wrote it; one paragraph per source paragraph, same order; keep names and numbers>
${wordsRules(tgt)}`;
  const absorb = (t, done) => {
    if (ov) {
      const r = parseOverlay(t);
      state.blocks.forEach((b, i) => { if (r.map[i + 1]) b.tr = r.map[i + 1]; });
      const words = done ? r.words : r.words.filter(w => w._ok);
      applyResult(state.blocks.map(b => b.tr).filter(Boolean).join("\n"), words, done, r.wordsStarted);
      layoutOverlay();
      return words;
    }
    const r = parseOut(t);
    const words = done ? r.words : r.words.filter(w => w._ok);
    applyResult(done ? (r.tr || t.trim()) : r.tr, words, done, r.wordsStarted);
    return words;
  };
  try {
    const out = await streamText([prompt], t => { if (!ctl.signal.aborted) absorb(t, false); }, ctl.signal);
    if (ctl.signal.aborted) return;
    const words = absorb(out, true).map(({ _ok, ...w }) => w);
    state.words = words;
    const took = secs(performance.now() - t0);
    $("trSt").textContent = took + " วิ";
    remember(key, { tr: state.tr, words, btr: ov ? state.blocks.map(b => b.tr || "") : null });
    afterTranslate(ov, "แปลเสร็จใน " + took + " วินาที");
  } catch (e) {
    if (ctl.signal.aborted) return;
    showErr(aiErr(e)); sheetTo("mid"); $("goRow").hidden = false;
    if (!state.tr) $("trText").textContent = "";
  } finally {
    if (state.trCtl === ctl) { state.busy = false; $("goTr").disabled = !state.text; }
  }
}
function afterTranslate(ov, sub) {
  $("goRow").hidden = true;
  const no = savePage();
  resHead(cur.id ? cur.title : autoTitle(state.text), (no ? "หน้า " + no + " · " : "") + sub);
  if (ov) { layoutOverlay(); sheetTo("low"); }
}

/* ================= overlay drawing ================= */
function layoutOverlay() {
  const ov = $("ov");
  const liveView = mode === "live" && L.blocks.length && L.frame;
  if (S.view !== "overlay" || !state.blocks.length || !(liveView || (mode === "frozen" && photo.naturalWidth))) { ov.hidden = true; return; }
  const st = $("stage").getBoundingClientRect();
  if (liveView) {
    // the live frame was cut to exactly what the viewfinder shows, so it covers the whole screen
    Object.assign(ov.style, { left: "0px", top: "0px", width: st.width + "px", height: st.height + "px" });
    placeLive();
  } else {
    const iw = photo.naturalWidth, ih = photo.naturalHeight;
    const sc = Math.min(st.width / iw, st.height / ih), w = iw * sc, h = ih * sc;
    Object.assign(ov.style, { left: (st.width - w) / 2 + "px", top: (st.height - h) / 2 + "px", width: w + "px", height: h + "px", transform: "" });
  }
  const OW = parseFloat(ov.style.width), OH = parseFloat(ov.style.height);
  arrangeBlocks(state.blocks);
  ov.innerHTML = state.blocks.map((b, i) => {
    if (b.dup) return "";
    const g = boxGeom(b, OW, OH);
    const fresh = !b.shown; b.shown = true;
    const font = (b.italic ? "font-style:italic;" : "") + (b.bold ? "font-weight:700;" : "");
    return `<div class="ov-b${b.off ? " off" : ""}${fresh ? " new" : ""}" data-i="${i}" style="left:${(g.cx - g.w / 2).toFixed(1)}px;top:${(g.cy - g.h / 2).toFixed(1)}px;width:${g.w.toFixed(1)}px;height:${g.h.toFixed(1)}px;${g.a ? `transform:rotate(${g.a}deg);` : ""}--bg:${b.bg || "#fff"};color:${b.fg || "#111"};${font}"><span>${esc(b.tr)}</span></div>`;
  }).join("");
  ov.hidden = false;
  ov.querySelectorAll(".ov-b").forEach(el => fitBox(el, state.blocks[+el.dataset.i]));
}
/* The page is one sheet of paper/screen, so all its text shares one tilt. Also remove duplicate boxes and
   trim boxes that run into the next one, so translations never sit on top of each other. */
function arrangeBlocks(blocks) {
  const vis = blocks.filter(b => b.box);
  // page angle: the angle most of the text agrees on (weighted by box size)
  const quads = {}; vis.forEach(b => { const q = b.rot || 0; quads[q] = (quads[q] || 0) + 1; });
  const pq = +Object.keys(quads).sort((a, c) => quads[c] - quads[a])[0] || 0;
  const same = vis.filter(b => (b.rot || 0) === pq).map(b => [b.ang ?? pq, (b.box[2] - b.box[0]) * (b.box[3] - b.box[1])]).sort((a, c) => a[0] - c[0]);
  let pageAng = pq;
  if (same.length) { const tot = same.reduce((t, x) => t + x[1], 0); let acc = 0; for (const [a, w] of same) { acc += w; if (acc >= tot / 2) { pageAng = a; break; } } }
  vis.forEach(b => { b.useAng = (b.rot || 0) === pq ? pageAng : (b.ang ?? b.rot ?? 0); b.lay = b.box.slice(); b.dup = false; });
  const area = x => (x[2] - x[0]) * (x[3] - x[1]);
  for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
    const a = vis[i], c = vis[j]; if (a.dup || c.dup) continue;
    const A = a.lay, C = c.lay;
    const iy = Math.min(A[2], C[2]) - Math.max(A[0], C[0]), ix = Math.min(A[3], C[3]) - Math.max(A[1], C[1]);
    if (iy <= 0 || ix <= 0) continue;
    if (iy * ix > 0.6 * Math.min(area(A), area(C))) { (area(A) >= area(C) ? c : a).dup = true; continue; } // the same text twice
    if (pq % 180 === 0 && ix > 0.3 * Math.min(A[3] - A[1], C[3] - C[1])) {
      // one above the other and touching: make the upper one stop where the lower one starts
      const [up, lo] = A[0] <= C[0] ? [A, C] : [C, A];
      up[2] = Math.max(up[0] + (up[2] - up[0]) * 0.45, lo[0] - 2);
    } else if (pq % 180 !== 0 && iy > 0.3 * Math.min(A[2] - A[0], C[2] - C[0])) {
      const [lf, rt] = A[1] <= C[1] ? [A, C] : [C, A];
      lf[3] = Math.max(lf[1] + (lf[3] - lf[1]) * 0.45, rt[1] - 2);
    }
  }
}
// the box Gemini gives is upright; for turned/tilted text, find the turned box of the same text inside it
function boxGeom(b, OW, OH) {
  const [y0, x0, y1, x1] = b.lay || b.box;
  const BW = (x1 - x0) / 1000 * OW, BH = (y1 - y0) / 1000 * OH, cx = (x0 + x1) / 2000 * OW, cy = (y0 + y1) / 2000 * OH;
  const a = b.useAng ?? b.ang ?? 0;
  if (!a) return { cx, cy, w: BW, h: BH, a: 0 };
  const r = a * Math.PI / 180, C = Math.abs(Math.cos(r)), Sn = Math.abs(Math.sin(r)), k = C * C - Sn * Sn;
  const sideways = Sn > C; // turned about 90 degrees: the text runs up/down the screen
  let w = (BW * C - BH * Sn) / k, h = (BH * C - BW * Sn) / k;
  const longSide = sideways ? BH : BW, shortSide = sideways ? BW : BH;
  if (!(Math.abs(k) > 0.2) || !(w > longSide * 0.5) || !(h > 0)) { w = longSide; h = shortSide * 0.9; }
  else if (h < shortSide * 0.3) h = Math.max(shortSide * 0.45, 12);
  return { cx, cy, w, h, a };
}
// biggest font that still fits the translation inside the original text's box
function fitBox(el, b) {
  const sp = el.firstChild, W = el.clientWidth, H = el.clientHeight;
  let lo = 6, hi = Math.max(8, Math.min(72, H * 0.95)), best = lo;
  for (let n = 0; n < 8; n++) {
    const m = (lo + hi) / 2; sp.style.fontSize = m + "px";
    if (sp.offsetHeight <= H + 1 && sp.scrollWidth <= W + 1) { best = m; lo = m; } else hi = m;
  }
  sp.style.fontSize = best.toFixed(1) + "px"; b.fs = best;
  if (sp.offsetHeight > H + 1) { el.style.height = Math.min(sp.offsetHeight + 2, H * 1.35) + "px"; el.style.overflow = "hidden"; }
  b.hpx = el.offsetHeight;
}
$("ov").addEventListener("click", e => {
  const el = e.target.closest(".ov-b"); if (!el) return;
  e.stopPropagation();
  const b = state.blocks[+el.dataset.i]; if (!b) return;
  b.off = !b.off; el.classList.toggle("off", b.off); // tap a box to peek at the original text under it
});
if (window.ResizeObserver) new ResizeObserver(() => layoutOverlay()).observe($("stage"));
function applyView() { goLive(); }

/* ================= save to gallery ================= */
function autoTitle(t) {
  const first = t.split(/(?<=[.!?。！？])\s|\n/)[0].trim();
  return first.length > 52 ? first.slice(0, 50).replace(/\s+\S*$/, "") + "…" : first || "บทความใหม่";
}
function savePage() {
  if (!user || !state.text || !state.tr) return 0;
  const uid = user.uid;
  const words = state.words.map(w => ({ word: w.word || "", ipa: w.ipa || "", pos: w.pos || "", lv: w.lv || "", mean: w.mean || "", ctx: w.ctx || "" }));
  const blocks = state.blocks.map(b => ({ box: b.box, text: b.text, tr: b.tr || "" }));
  const pageData = { src: state.text, tr: state.tr, words, blocks, tgt: S.tgt, lv: S.lv, updatedAt: serverTimestamp() };
  const fail = () => toast("บันทึกลงแกลเลอรีไม่สำเร็จค่ะ");
  if (state.pageId && state.pageArticle) {
    updateDoc(doc(db, "users", uid, "articles", state.pageArticle, "pages", state.pageId), pageData).catch(fail);
    updateDoc(doc(db, "users", uid, "articles", state.pageArticle), { updatedAt: serverTimestamp() }).catch(() => {});
    return state.pageNo;
  }
  const batch = writeBatch(db);
  // pages shot within 20 minutes of each other belong to the same article
  if (cur.id && Date.now() - (cur.lastAt || 0) > 20 * 60 * 1000) cur = { id: null, title: "", count: 0 };
  const isNew = !cur.id;
  const aref = isNew ? doc(collection(db, "users", uid, "articles")) : doc(db, "users", uid, "articles", cur.id);
  const no = isNew ? 1 : cur.count + 1;
  const pref = doc(collection(aref, "pages"));
  const title = isNew ? autoTitle(state.text) : cur.title;
  batch.set(pref, { ...pageData, thumb: state.thumb, img: state.img, order: no, createdAt: serverTimestamp() });
  batch.set(doc(db, "users", uid, "shots", pref.id), { articleId: aref.id, order: no, title, thumb: state.thumb, createdAt: serverTimestamp() });
  if (isNew) {
    batch.set(aref, { title, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), pageCount: 1, cover: state.thumb, preview: state.tr.slice(0, 160), search: (title + " " + state.text.slice(0, 300) + " " + state.tr.slice(0, 300)).toLowerCase() });
    cur = { id: aref.id, title, count: 1 };
  } else {
    batch.update(aref, { pageCount: increment(1), updatedAt: serverTimestamp() });
    cur.count = no;
  }
  cur.lastAt = Date.now();
  saveCur();
  Object.assign(state, { pageId: pref.id, pageArticle: aref.id, pageNo: no });
  batch.commit().catch(fail);
  galleryStale = true;
  return no;
}

/* ================= result sheet: away / low / mid / full ================= */
let sheetState = "away";
function insetPx(side) {
  const p = document.createElement("div"); p.style.cssText = `position:fixed;visibility:hidden;height:env(safe-area-inset-${side},0px)`;
  document.body.appendChild(p); const h = p.offsetHeight; p.remove(); return h;
}
function sheetHeights() {
  const H = $("app").clientHeight, hdr = $("sheet").querySelector(".sheet-h");
  if (mode === "live") {
    const low = hdr.offsetTop + hdr.offsetHeight + insetPx("bottom") + 10;
    return { low, peek: Math.max(low + 110, Math.round(H * 0.42)), mid: Math.max(low + 160, Math.round(H * 0.68)), full: Math.max(low + 160, H - insetPx("top") - 70) };
  }
  const low = hdr.offsetTop + hdr.offsetHeight + insetPx("bottom") + 10;
  return { low, peek: Math.max(low + 90, Math.round(H * 0.4)), mid: Math.max(low + 160, Math.round(H * 0.62)), full: Math.max(low + 160, H - insetPx("top") - 70) };
}
function sheetTo(name) {
  sheetState = name;
  const sh = $("sheet");
  $("app").classList.toggle("sheet-on", name !== "away");
  if (mode === "live" && S.view === "card" && state.text && name !== "away") $("resSub").textContent = name === "mid" || name === "full" ? HOLD_SUB : LIVE_SUB;
  $("keepBtn").hidden = !(mode === "live" && S.view === "card");
  if (name === "away") { sh.classList.add("away"); return; }
  sh.classList.remove("away");
  if ($("app").hidden) return;
  $("app").style.setProperty("--sh", sheetHeights()[name] + "px");
}
window.addEventListener("resize", () => { if (sheetState !== "away") sheetTo(sheetState); });
(() => {
  const grip = $("grip"), sheet = $("sheet"), appEl = $("app");
  let startY = 0, startH = 0, moved = false, dragging = false;
  grip.addEventListener("pointerdown", e => { dragging = true; moved = false; startY = e.clientY; startH = sheet.offsetHeight; grip.setPointerCapture(e.pointerId); sheet.classList.add("dragging"); });
  grip.addEventListener("pointermove", e => {
    if (!dragging) return;
    const dy = startY - e.clientY; if (Math.abs(dy) > 4) moved = true;
    if (moved) { const hs = sheetHeights(); appEl.style.setProperty("--sh", Math.max(hs.low, Math.min(hs.full, startH + dy)) + "px"); }
  });
  const end = () => {
    if (!dragging) return; dragging = false; sheet.classList.remove("dragging");
    if (!moved) { sheetTo(sheetState === "mid" || sheetState === "full" ? (mode === "live" ? "peek" : "low") : "mid"); return; }
    const h = sheet.offsetHeight, hs = sheetHeights();
    sheetTo(Object.keys(hs).reduce((a, k) => Math.abs(hs[k] - h) < Math.abs(hs[a] - h) ? k : a, "low"));
  };
  grip.addEventListener("pointerup", end); grip.addEventListener("pointercancel", end);
  grip.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sheetTo(sheetState === "mid" || sheetState === "full" ? (mode === "live" ? "peek" : "low") : "mid"); } });
})();

/* ================= pages (gallery / viewer / settings) ================= */
const panelStack = [];
let ignorePop = false;
function openPanel(id) { $(id).hidden = false; panelStack.push(id); history.pushState({ lumi: id }, ""); $("toast").hidden = true; }
function closeTop() { const id = panelStack.pop(); if (id) $(id).hidden = true; }
function closePanels() { while (panelStack.length) closeTop(); }
window.addEventListener("popstate", () => { if (ignorePop) { ignorePop = false; return; } if (panelStack.length) closeTop(); });
document.querySelectorAll("[data-back]").forEach(b => { b.onclick = () => history.back(); });
function backToCamera() { const n = panelStack.length; closePanels(); if (n) { ignorePop = true; history.go(-n); } }
$("openSet").onclick = () => openPanel("set");

/* ---------- gallery ---------- */
let shots = [], articles = [], galleryStale = true;
const fmtDay = d => {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const diff = Math.round((t - x) / 864e5);
  return diff === 0 ? "วันนี้" : diff === 1 ? "เมื่อวาน" : d.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
};
const tsDate = ts => (ts?.toDate ? ts.toDate() : new Date());
$("openGal").onclick = () => openGallery();
function galTab(v) { press("#galSeg button", v); $("galPhotos").hidden = v !== "photos"; $("galArticles").hidden = v !== "articles"; }
async function openGallery() {
  openPanel("gal"); galTab("articles");
  if (!galleryStale) { renderPhotos(); renderArticles(); return; }
  $("galPhotos").innerHTML = `<div class="empty dots">กำลังโหลด</div>`;
  try {
    const [s, a] = await Promise.all([
      getDocs(query(collection(db, "users", user.uid, "shots"), orderBy("createdAt", "desc"), limit(300))),
      getDocs(query(collection(db, "users", user.uid, "articles"), orderBy("updatedAt", "desc"), limit(200)))
    ]);
    shots = s.docs.map(d => ({ id: d.id, ...d.data() }));
    articles = a.docs.map(d => ({ id: d.id, ...d.data() }));
    galleryStale = false;
    renderPhotos(); renderArticles();
  } catch (e) { $("galPhotos").innerHTML = `<div class="empty">โหลดแกลเลอรีไม่ได้ค่ะ เช็กอินเทอร์เน็ตแล้วลองใหม่นะคะ</div>`; }
}
function renderPhotos() {
  if (!shots.length) {
    $("galPhotos").innerHTML = `<div class="empty">ยังไม่มีรูปค่ะ<br>ถ่ายแล้วแปลหน้าแรก รูปจะมาอยู่ตรงนี้เอง${articles.length ? "<br><br>รูปที่ถ่ายก่อนอัปเดตนี้ อยู่ในแท็บ “บทความ” นะคะ" : ""}</div>`;
    return;
  }
  let html = "", day = "";
  for (const s of shots) {
    const d = fmtDay(tsDate(s.createdAt));
    if (d !== day) { html += (day ? "</div>" : "") + `<div class="day">${esc(d)}</div><div class="grid">`; day = d; }
    html += `<button type="button" data-a="${s.articleId}" data-p="${s.id}" aria-label="${esc(s.title)} หน้า ${s.order}"><img src="${s.thumb}" alt="" loading="lazy"><span class="badge">หน้า ${s.order}</span></button>`;
  }
  $("galPhotos").innerHTML = html + "</div>";
}
function renderArticles() {
  const q = $("q").value.trim().toLowerCase();
  const list = q ? articles.filter(a => (a.search || "").includes(q) || (a.title || "").toLowerCase().includes(q)) : articles;
  $("alist").innerHTML = !articles.length ? `<div class="empty">ยังไม่มีบทความค่ะ</div>`
    : !list.length ? `<div class="empty">ไม่เจอบทความที่ตรงกับ “${esc(q)}” ค่ะ</div>`
    : list.map(a => `<button class="art" type="button" data-a="${a.id}"><span class="stack">${(a.pageCount || 0) > 1 ? "<span></span>" : ""}${a.cover ? `<img src="${a.cover}" alt="">` : ""}</span><span><b>${esc(a.title)}</b><small>${a.pageCount || 0} หน้า · ${esc(fmtDay(tsDate(a.updatedAt)))}</small><span class="pv">${esc(a.preview || "")}</span></span></button>`).join("");
}
$("q").addEventListener("input", renderArticles);
$("galSeg").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  galTab(b.dataset.v);
};
$("galPhotos").addEventListener("click", e => { const b = e.target.closest("button[data-a]"); if (b) openViewer(b.dataset.a, b.dataset.p); });
$("alist").addEventListener("click", e => { const b = e.target.closest("button[data-a]"); if (b) openViewer(b.dataset.a, null); });

/* ---------- viewer ---------- */
let V = { aid: null, title: "", pageCount: 0, pages: [], idx: 0 };
async function openViewer(aid, pid) {
  openPanel("viewer");
  $("vTitle").textContent = "กำลังโหลด…"; $("vContent").innerHTML = ""; $("vImg").removeAttribute("src"); $("vDots").innerHTML = "";
  try {
    const [a, p] = await Promise.all([
      getDoc(doc(db, "users", user.uid, "articles", aid)),
      getDocs(query(collection(db, "users", user.uid, "articles", aid, "pages"), orderBy("order")))
    ]);
    const ad = a.exists() ? a.data() : { title: "บทความ" };
    V = { aid, title: ad.title || "บทความ", pageCount: ad.pageCount || 0, pages: p.docs.map(d => ({ id: d.id, ...d.data() })), idx: 0 };
    if (pid) V.idx = Math.max(0, V.pages.findIndex(x => x.id === pid));
    renderViewer();
  } catch (e) { $("vTitle").textContent = "บทความ"; $("vContent").innerHTML = `<div class="empty">โหลดไม่ได้ค่ะ ลองใหม่นะคะ</div>`; }
}
function renderViewer() {
  $("vTitle").textContent = V.title;
  const p = V.pages[V.idx];
  if (!p) { $("vContent").innerHTML = `<div class="empty">บทความนี้ยังไม่มีหน้าค่ะ</div>`; $("vImgBox").hidden = true; return; }
  $("vImgBox").hidden = !(p.img || p.thumb);
  if (p.img || p.thumb) $("vImg").src = p.img || p.thumb;
  $("vPrev").disabled = V.idx === 0; $("vNext").disabled = V.idx >= V.pages.length - 1;
  $("vDots").innerHTML = V.pages.length > 1 ? V.pages.map((_, i) => `<i class="${i === V.idx ? "on" : ""}"></i>`).join("") : "";
  const words = p.words || [];
  $("vContent").innerHTML =
    `<div class="card"><div class="lbl">คำแปล · หน้า ${p.order}</div><div class="tr">${esc(p.tr)}</div></div>`
    + `<div class="card"><div class="lbl">ต้นฉบับ</div><div class="src" id="vSrc">${markText(p.src || "", words)}</div></div>`
    + (words.length ? `<div><div class="lbl pad">คำศัพท์น่ารู้</div><div class="words">${words.map((w, i) => wordCard(w, i, "vw")).join("")}</div></div>` : "");
  jumpToWord($("vSrc"), "vw", false);
}
$("vPrev").onclick = () => { if (V.idx > 0) { V.idx--; renderViewer(); } };
$("vNext").onclick = () => { if (V.idx < V.pages.length - 1) { V.idx++; renderViewer(); } };
(() => {
  let x0 = null;
  $("vImgBox").addEventListener("touchstart", e => { x0 = e.touches[0].clientX; }, { passive: true });
  $("vImgBox").addEventListener("touchend", e => {
    if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (dx < -50) $("vNext").click(); else if (dx > 50) $("vPrev").click();
  });
})();
const showBox = (id, on) => { $(id).hidden = !on; };
$("vMore").onclick = () => showBox("vMenu", true);
$("mClose").onclick = () => showBox("vMenu", false);
$("vMenu").addEventListener("click", e => { if (e.target === $("vMenu")) showBox("vMenu", false); });
$("mContinue").onclick = () => {
  showBox("vMenu", false);
  cur = { id: V.aid, title: V.title, count: Math.max(V.pageCount, V.pages.length), lastAt: Date.now() };
  state.pageId = null; saveCur(); backToCamera(); goLive();
  toast(`สแกนต่อเป็นหน้า ${cur.count + 1} ค่ะ`);
};
$("mRename").onclick = () => { showBox("vMenu", false); $("renameIn").value = V.title; showBox("vRenameBox", true); $("renameIn").focus(); };
$("renameNo").onclick = () => showBox("vRenameBox", false);
$("renameYes").onclick = () => {
  const t = $("renameIn").value.trim(); showBox("vRenameBox", false);
  if (!t || t === V.title) return;
  V.title = t; $("vTitle").textContent = t;
  updateDoc(doc(db, "users", user.uid, "articles", V.aid), { title: t }).catch(() => toast("เปลี่ยนชื่อไม่สำเร็จค่ะ"));
  const a = articles.find(x => x.id === V.aid); if (a) { a.title = t; a.search = (t + " " + (a.search || "")).toLowerCase(); renderArticles(); }
  if (cur.id === V.aid) { cur.title = t; saveCur(); }
  toast("เปลี่ยนชื่อแล้วค่ะ");
};
$("mDelete").onclick = () => { showBox("vMenu", false); showBox("vDelBox", true); };
$("delNo").onclick = () => showBox("vDelBox", false);
$("delYes").onclick = () => {
  showBox("vDelBox", false);
  const batch = writeBatch(db);
  V.pages.forEach(p => {
    batch.delete(doc(db, "users", user.uid, "articles", V.aid, "pages", p.id));
    batch.delete(doc(db, "users", user.uid, "shots", p.id));
  });
  batch.delete(doc(db, "users", user.uid, "articles", V.aid));
  batch.commit().catch(() => toast("ลบไม่สำเร็จค่ะ"));
  articles = articles.filter(x => x.id !== V.aid); shots = shots.filter(s => s.articleId !== V.aid);
  renderPhotos(); renderArticles();
  if (cur.id === V.aid) { cur = { id: null, title: "บทความใหม่", count: 0 }; saveCur(); }
  history.back(); toast("ลบบทความแล้วค่ะ");
};

/* ================= clean up the old offline cache ================= */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(() => {});
}
