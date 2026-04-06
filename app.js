/* ═══════════════════════════════════════════════════════════════
   STUDYTRACK · app.js  (Frontend — calls Vercel backend)
   ─────────────────────────────────────────────────────────────
   After deploying your Vercel backend:
   1. Copy your Vercel deployment URL
      e.g. https://studytrack-backend.vercel.app
   2. Paste it below as BACKEND_URL (no trailing slash)
   3. Push this file to GitHub Pages. Done — API key is safe.
═══════════════════════════════════════════════════════════════ */

// ────────────────────────────────────────────────────────────
// ⚙️  ONLY LINE YOU CHANGE AFTER DEPLOYING BACKEND
// ────────────────────────────────────────────────────────────
const BACKEND_URL = "https://YOUR_VERCEL_APP.vercel.app"; // ← paste Vercel URL

// Formspree endpoint for contact form (optional)
const FORMSPREE_URL = "https://formspree.io/f/YOUR_FORM_ID";

// ────────────────────────────────────────────────────────────
// STATE
// ────────────────────────────────────────────────────────────
let guestId         = "";
let uploadedFiles   = {};
let topicsData      = {};
let notesData       = {};

let currentFile     = null;
let currentPdfDoc   = null;
let currentPage     = 1;
let totalPages      = 0;
let pdfScale        = 1.4;
let currentTopicTab = "remaining";
let topicFilter     = "all";
let notesTimer      = null;
let isRenderingPDF  = false;

const MAX_FILES_GUEST = 5;

// ────────────────────────────────────────────────────────────
// PDF.js WORKER
// ────────────────────────────────────────────────────────────
if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

/* ═══════════════════════════════════════════════════════════════
   INDEXEDDB — PDF storage (avoids localStorage 5 MB limit)
═══════════════════════════════════════════════════════════════ */
const IDB_NAME  = "StudyTrackDB";
const IDB_STORE = "pdfs";
let _idb = null;

function openIDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
    req.onerror   = () => reject(req.error);
  });
}

async function savePDFToIDB(key, dataUrl) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(dataUrl, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

async function getPDFFromIDB(key) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => res(req.result || null);
    req.onerror   = () => rej(req.error);
  });
}

async function deletePDFFromIDB(key) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

function idbKey(fileName) { return `${guestId}::${fileName}`; }

/* ═══════════════════════════════════════════════════════════════
   LOCAL STORAGE — metadata, topics, notes
═══════════════════════════════════════════════════════════════ */
function storageKey() { return `studytrack_${guestId}`; }

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return;
    const d = JSON.parse(raw);
    uploadedFiles = d.uploadedFiles || {};
    notesData     = d.notesData     || {};
    topicsData    = {};
    for (const fn in (d.topicsData || {})) {
      const td = d.topicsData[fn];
      topicsData[fn] = {
        remaining: td.remaining || [],
        covered:   td.covered   || [],
        important: td.important || []
      };
    }
  } catch(e) { console.warn("Storage load error:", e); }
}

function saveToStorage() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ uploadedFiles, notesData, topicsData }));
  } catch(e) {
    toast("Storage nearly full. Remove older files.", "error");
  }
}

/* ═══════════════════════════════════════════════════════════════
   BACKEND HEALTH CHECK
═══════════════════════════════════════════════════════════════ */
async function checkBackend() {
  const badge = document.getElementById("backendStatusBadge");
  if (!badge) return;
  if (BACKEND_URL.includes("YOUR_VERCEL_APP")) {
    badge.textContent = "🔧 Backend URL Not Set"; badge.className = "backend-status-badge status-warn"; return;
  }
  try {
    const resp = await fetch(`${BACKEND_URL}/api/health`, { signal: AbortSignal.timeout(6000) });
    const data = await resp.json();
    if (data.ok && data.keyConfigured) { badge.textContent="⚡ AI Ready"; badge.className="backend-status-badge status-online"; }
    else { badge.textContent="⚠️ Key Missing"; badge.className="backend-status-badge status-warn"; }
  } catch {
    badge.textContent="🔴 Backend Offline"; badge.className="backend-status-badge status-error";
  }
}

/* ═══════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {
  initGuestId();
  loadFromStorage();
  setupUploadZone();
  renderFileList();
  renderTopicsFilePicker();
  renderInsights();
  updateQuickStats();
  checkBackend();
});

/* ═══════════════════════════════════════════════════════════════
   GUEST ID
═══════════════════════════════════════════════════════════════ */
function initGuestId() {
  guestId = localStorage.getItem("st_guest_id");
  if (!guestId) {
    guestId = "ST-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    localStorage.setItem("st_guest_id", guestId);
  }
  document.getElementById("guestIdDisplay").textContent = guestId;
}

function showUserPanel() {
  const body = document.getElementById("userModalBody");
  body.innerHTML = `
    <div style="background:var(--parchment);border-radius:12px;padding:16px;margin-bottom:16px;">
      <div style="font-size:12px;color:var(--text-light);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px;font-weight:600;">Your Guest ID</div>
      <div style="font-size:20px;font-weight:700;font-family:'Lora',serif;color:var(--accent-dark);letter-spacing:2px;">${guestId}</div>
      <div style="font-size:12px;color:var(--text-light);margin-top:6px;">Save this to restore your data on this browser.</div>
    </div>
    <div class="form-group">
      <label>Switch to a different Guest ID</label>
      <input class="form-input" id="guestIdInput" value="${guestId}" placeholder="e.g. ST-ABC123"/>
    </div>
    <p style="font-size:12px;color:var(--text-light);line-height:1.5;">All data lives in your browser. No cloud storage.</p>`;
  document.getElementById("userModalActions").innerHTML = `
    <button class="btn btn-secondary btn-sm" onclick="closeModal('userModal')">Cancel</button>
    <button class="btn btn-primary   btn-sm" onclick="applyGuestId()">Apply ID</button>`;
  openModal("userModal");
}

function applyGuestId() {
  const val = (document.getElementById("guestIdInput")?.value || "").trim();
  if (!val) { toast("Please enter a valid ID.", "warning"); return; }
  guestId = val;
  localStorage.setItem("st_guest_id", guestId);
  document.getElementById("guestIdDisplay").textContent = guestId;
  loadFromStorage(); renderFileList(); renderTopicsFilePicker(); renderInsights(); updateQuickStats();
  closeModal("userModal"); toast("Guest ID applied!", "success");
}

/* ═══════════════════════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════════════════════ */
function navTo(page) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach(a => a.classList.remove("active"));
  const pageEl = document.getElementById("page-" + page);
  const navEl  = document.getElementById("nav-" + page);
  if (!pageEl) return;
  pageEl.classList.add("active");
  if (navEl) navEl.classList.add("active");
  window.scrollTo(0, 0);
  if (page === "insights") { renderInsights(); updateQuickStats(); }
  if (page === "topics")   { renderTopicsFilePicker(); renderTopicList(); }
  if (page === "home")     { updateQuickStats(); }
}

function mobileNavTo(page) {
  document.getElementById("mobileMenu").classList.remove("open");
  document.getElementById("hamburgerBtn").classList.remove("open");
  navTo(page);
}

function toggleMobileMenu() {
  const menu = document.getElementById("mobileMenu");
  const btn  = document.getElementById("hamburgerBtn");
  const open = menu.classList.toggle("open");
  btn.classList.toggle("open", open);
  menu.setAttribute("aria-hidden", String(!open));
}

/* ═══════════════════════════════════════════════════════════════
   MODALS
═══════════════════════════════════════════════════════════════ */
function openModal(id)  { document.getElementById(id).classList.add("open"); }
function closeModal(id) { document.getElementById(id).classList.remove("open"); }
function handleOverlayClick(e, id) {
  if (e.target === document.getElementById(id)) closeModal(id);
}

/* ═══════════════════════════════════════════════════════════════
   FILE UPLOAD
═══════════════════════════════════════════════════════════════ */
function setupUploadZone() {
  const zone = document.getElementById("uploadZone");
  if (!zone) return;
  zone.addEventListener("click",   () => document.getElementById("fileInput").click());
  zone.addEventListener("keydown", e => { if (e.key==="Enter"||e.key===" ") document.getElementById("fileInput").click(); });
  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", ()  => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("drag-over");
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith(".pdf")||f.type==="application/pdf");
    if (!files.length) { toast("Only PDF files are supported.", "error"); return; }
    processFiles(files);
  });
}

function handleFileUpload(event) {
  processFiles(Array.from(event.target.files));
  event.target.value = "";
}

async function processFiles(files) {
  for (const file of files) {
    if (!file.name.endsWith(".pdf") && file.type !== "application/pdf") {
      toast(`"${file.name}" is not a PDF.`, "error"); continue;
    }
    if (uploadedFiles[file.name]) {
      toast(`"${file.name}" already exists.`, "warning"); continue;
    }
    if (Object.keys(uploadedFiles).length >= MAX_FILES_GUEST) {
      toast(`Guest limit (${MAX_FILES_GUEST} files) reached.`, "error"); break;
    }
    try {
      const dataUrl = await readFileAsDataURL(file);
      await savePDFToIDB(idbKey(file.name), dataUrl);
      uploadedFiles[file.name] = {
        name: file.name, size: file.size,
        uploadDate: new Date().toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" })
      };
      if (!topicsData[file.name]) topicsData[file.name] = { remaining:[], covered:[], important:[] };
      toast(`"${file.name}" uploaded!`, "success");
    } catch(err) { toast(`Upload failed: ${err.message}`, "error"); }
  }
  saveToStorage(); renderFileList(); renderTopicsFilePicker(); renderInsights(); updateQuickStats();
}

function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = e => res(e.target.result);
    fr.onerror = () => rej(new Error("FileReader failed"));
    fr.readAsDataURL(file);
  });
}

/* ═══════════════════════════════════════════════════════════════
   FILE LIST RENDER
═══════════════════════════════════════════════════════════════ */
function renderFileList() {
  const list  = document.getElementById("fileList");
  const noMsg = document.getElementById("noFilesMsg");
  const chip  = document.getElementById("fileCountChip");
  const count = Object.keys(uploadedFiles).length;
  chip.textContent       = `${count} / ${MAX_FILES_GUEST} files`;
  chip.style.background  = count >= MAX_FILES_GUEST ? "var(--red-light)"  : "var(--parchment)";
  chip.style.color       = count >= MAX_FILES_GUEST ? "var(--red)"        : "var(--text-mid)";
  list.querySelectorAll(".file-item").forEach(el => el.remove());
  noMsg.style.display = count ? "none" : "block";
  Object.values(uploadedFiles).forEach(f => {
    const item = document.createElement("div");
    item.className = "file-item" + (currentFile===f.name ? " active" : "");
    item.innerHTML = `
      <div class="file-thumb">📄</div>
      <div class="file-info">
        <div class="file-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
        <div class="file-meta">${(f.size/1024).toFixed(1)} KB · ${f.uploadDate}</div>
      </div>
      <div class="file-actions">
        <button class="btn btn-success btn-sm" onclick="openFile(event,'${escAttr(f.name)}')">Open</button>
        <button class="btn btn-danger  btn-sm" onclick="confirmDelete(event,'${escAttr(f.name)}')">✕</button>
      </div>`;
    list.insertBefore(item, noMsg);
  });
}

function openFile(e, fileName) {
  if (e) e.stopPropagation();
  saveNotes(true);
  currentFile = fileName;
  navTo("viewer");
  loadPDF(fileName);
  loadNotesForFile(fileName);
  document.getElementById("pdfFileName").textContent    = fileName;
  document.getElementById("notesFileLabel").textContent = fileName;
  document.getElementById("viewerSubtitle").textContent = "Reading: " + fileName;
  const sb = document.getElementById("summaryBox");
  if (sb) sb.style.display = "none";
  renderFileList();
}

function confirmDelete(e, fileName) {
  if (e) e.stopPropagation();
  document.getElementById("deleteModalMsg").textContent = `Delete "${fileName}" and all its topics and notes?`;
  document.getElementById("confirmDeleteBtn").onclick = () => { deleteFile(fileName); closeModal("deleteModal"); };
  openModal("deleteModal");
}

async function deleteFile(fileName) {
  await deletePDFFromIDB(idbKey(fileName)).catch(()=>{});
  delete uploadedFiles[fileName]; delete topicsData[fileName]; delete notesData[fileName];
  if (currentFile === fileName) {
    currentFile = null; currentPdfDoc = null;
    document.getElementById("pdfCanvas").style.display      = "none";
    document.getElementById("pdfPlaceholder").style.display = "flex";
    document.getElementById("pdfFileName").textContent      = "No file selected";
    document.getElementById("pageInfo").textContent         = "— / —";
    document.getElementById("prevPageBtn").disabled = true;
    document.getElementById("nextPageBtn").disabled = true;
  }
  saveToStorage(); renderFileList(); renderTopicsFilePicker(); renderInsights(); updateQuickStats();
  toast(`"${fileName}" deleted.`);
}

/* ═══════════════════════════════════════════════════════════════
   PDF VIEWER
═══════════════════════════════════════════════════════════════ */
async function loadPDF(fileName) {
  if (typeof pdfjsLib === "undefined") { toast("PDF.js not loaded.", "error"); return; }
  const canvas      = document.getElementById("pdfCanvas");
  const placeholder = document.getElementById("pdfPlaceholder");
  const loadingEl   = document.getElementById("pdfLoadingOverlay");
  placeholder.style.display = "none";
  canvas.style.display      = "none";
  loadingEl.style.display   = "flex";
  try {
    const dataUrl = await getPDFFromIDB(idbKey(fileName));
    if (!dataUrl) { toast("PDF not found. Please re-upload the file.", "error"); placeholder.style.display="flex"; loadingEl.style.display="none"; return; }
    currentPdfDoc = await pdfjsLib.getDocument(dataUrl).promise;
    totalPages    = currentPdfDoc.numPages;
    currentPage   = 1;
    loadingEl.style.display = "none";
    canvas.style.display    = "block";
    await renderPDFPage();
  } catch(err) {
    loadingEl.style.display = "none"; placeholder.style.display = "flex";
    toast("Failed to load PDF: " + err.message, "error");
  }
}

async function renderPDFPage() {
  if (!currentPdfDoc || isRenderingPDF) return;
  isRenderingPDF = true;
  try {
    const page     = await currentPdfDoc.getPage(currentPage);
    const viewport = page.getViewport({ scale: pdfScale });
    const canvas   = document.getElementById("pdfCanvas");
    const ctx      = canvas.getContext("2d");
    const ratio    = window.devicePixelRatio || 1;
    canvas.width        = Math.floor(viewport.width  * ratio);
    canvas.height       = Math.floor(viewport.height * ratio);
    canvas.style.width  = Math.floor(viewport.width)  + "px";
    canvas.style.height = Math.floor(viewport.height) + "px";
    ctx.scale(ratio, ratio);
    await page.render({ canvasContext: ctx, viewport }).promise;
    document.getElementById("pageInfo").textContent    = `${currentPage} / ${totalPages}`;
    document.getElementById("zoomDisplay").textContent = Math.round(pdfScale*100) + "%";
    document.getElementById("prevPageBtn").disabled    = currentPage <= 1;
    document.getElementById("nextPageBtn").disabled    = currentPage >= totalPages;
  } catch(err) {
    toast("Page render error: " + err.message, "error");
  } finally {
    isRenderingPDF = false;
  }
}

function changePage(delta) {
  const np = currentPage + delta;
  if (!currentPdfDoc || np<1 || np>totalPages) return;
  currentPage = np; renderPDFPage();
}

function zoomPDF(delta) {
  pdfScale = Math.max(0.4, Math.min(3.5, pdfScale + delta));
  if (currentPdfDoc) renderPDFPage();
}

/* ═══════════════════════════════════════════════════════════════
   NOTES EDITOR
═══════════════════════════════════════════════════════════════ */
function loadNotesForFile(fileName) {
  const editor = document.getElementById("notesEditor");
  editor.innerHTML = notesData[fileName] || "";
  updateWordCount();
  document.getElementById("noteSavedAt").textContent = "Loaded";
}

function onNotesInput() {
  updateWordCount();
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => saveNotes(true), 1800);
}

function saveNotes(auto = false) {
  if (!currentFile) return;
  notesData[currentFile] = document.getElementById("notesEditor").innerHTML;
  saveToStorage();
  if (!auto) toast("Notes saved!", "success");
  document.getElementById("noteSavedAt").textContent = "Saved " + new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"});
}

function clearNotes() {
  if (!currentFile) return;
  if (!confirm("Clear all notes for this file?")) return;
  document.getElementById("notesEditor").innerHTML = "";
  saveNotes(); updateWordCount(); toast("Notes cleared.");
}

function updateWordCount() {
  const text = document.getElementById("notesEditor").innerText || "";
  const wc   = text.trim() ? text.trim().split(/\s+/).length : 0;
  document.getElementById("wordCount").textContent = `${wc} word${wc!==1?"s":""}`;
}

function execCmd(cmd, val=null) { document.getElementById("notesEditor").focus(); document.execCommand(cmd,false,val); }
function insertRule() { execCmd("insertHTML","<hr style='border:none;border-top:2px solid #e2d9cc;margin:12px 0;'/>"); }

/* ═══════════════════════════════════════════════════════════════
   TOPICS TRACKER
═══════════════════════════════════════════════════════════════ */
function renderTopicsFilePicker() {
  const container = document.getElementById("topicsFilePicker");
  const files = Object.keys(uploadedFiles);
  if (!files.length) { container.innerHTML='<div class="empty-state small"><p>Upload a file first</p></div>'; return; }
  container.innerHTML = "";
  files.forEach(fn => {
    const btn = document.createElement("button");
    btn.textContent = "📄 " + fn; btn.title = fn;
    btn.className = currentFile===fn ? "active-file" : "";
    btn.onclick = () => {
      currentFile = fn;
      container.querySelectorAll("button").forEach(b => b.classList.remove("active-file"));
      btn.classList.add("active-file"); renderTopicList();
    };
    container.appendChild(btn);
  });
}

function switchTopicTab(tab) {
  currentTopicTab = tab;
  document.getElementById("tab-remaining").classList.toggle("active", tab==="remaining");
  document.getElementById("tab-covered").classList.toggle("active",   tab==="covered");
  renderTopicList();
}

function setTopicFilter(filter) {
  topicFilter = filter;
  document.getElementById("filterAll").classList.toggle("active",       filter==="all");
  document.getElementById("filterImportant").classList.toggle("active", filter==="important");
  renderTopicList();
}

function renderTopicList() {
  const container = document.getElementById("topicListContainer");
  if (!container) return;
  if (!currentFile || !topicsData[currentFile]) {
    container.innerHTML='<div class="empty-state"><div class="empty-icon">🗂️</div><p>Select a file on the left.</p></div>'; return;
  }
  const td     = topicsData[currentFile];
  const search = (document.getElementById("topicSearchInput")?.value||"").toLowerCase();
  let   list   = [...(td[currentTopicTab]||[])];
  if (search) list = list.filter(t => t.toLowerCase().includes(search));
  if (topicFilter==="important") list = list.filter(t => td.important.includes(t));
  document.getElementById("remainingCount").textContent = td.remaining.length;
  document.getElementById("coveredCount").textContent   = td.covered.length;
  if (!list.length) {
    const msg = currentTopicTab==="covered" ? "No covered topics yet."
      : search ? "No topics match search."
      : topicFilter==="important" ? "No important topics here."
      : "No remaining topics. 🎉";
    container.innerHTML=`<div class="empty-state"><div class="empty-icon">${currentTopicTab==="covered"?"✅":"📋"}</div><p>${msg}</p></div>`;
    return;
  }
  const ul = document.createElement("div");
  ul.className = "topic-list";
  list.forEach(topic => {
    const isImportant = td.important.includes(topic);
    const isCovered   = currentTopicTab==="covered";
    const safe = escAttr(topic);
    const item = document.createElement("div");
    item.className=["topic-item",isImportant?"important":"",isCovered?"covered":""].filter(Boolean).join(" ");
    item.innerHTML=`
      <div class="topic-check ${isCovered?"checked":""}" onclick="toggleCover('${safe}')">${isCovered?"✓":""}</div>
      <span class="topic-name ${isCovered?"covered":""}">${escHtml(topic)}</span>
      ${isImportant?'<span class="chip important" style="font-size:11px;flex-shrink:0;">★</span>':""}
      <button class="star-btn ${isImportant?"starred":""}" onclick="toggleImportant('${safe}')">★</button>
      <button class="del-btn" onclick="deleteTopic('${safe}')">🗑</button>`;
    ul.appendChild(item);
  });
  container.innerHTML=""; container.appendChild(ul);
}

function toggleCover(topic) {
  if (!currentFile) return;
  const td=topicsData[currentFile];
  if (td.remaining.includes(topic)){td.remaining=td.remaining.filter(t=>t!==topic);td.covered.push(topic);toast(`Covered: "${topic}"!`,"success");}
  else{td.covered=td.covered.filter(t=>t!==topic);td.remaining.push(topic);toast(`Moved back: "${topic}"`);}
  saveToStorage(); renderTopicList(); renderInsights(); updateQuickStats();
}

function toggleImportant(topic) {
  if (!currentFile) return;
  const td=topicsData[currentFile], idx=td.important.indexOf(topic);
  if (idx!==-1){td.important.splice(idx,1);toast("Removed from important.");}
  else{td.important.push(topic);toast("Marked important! ⭐","success");}
  saveToStorage(); renderTopicList(); renderInsights();
}

function deleteTopic(topic) {
  if (!currentFile) return;
  const td=topicsData[currentFile];
  td.remaining=td.remaining.filter(t=>t!==topic);
  td.covered=td.covered.filter(t=>t!==topic);
  td.important=td.important.filter(t=>t!==topic);
  saveToStorage(); renderTopicList(); renderInsights(); updateQuickStats();
  toast(`"${topic}" deleted.`);
}

function openAddTopicModal() {
  if (!currentFile) { toast("Select a file first.", "warning"); return; }
  const input=document.getElementById("addTopicInput");
  if (input) input.value="";
  openModal("addTopicModal");
  setTimeout(()=>input?.focus(),120);
}

function confirmAddTopic() {
  const val=(document.getElementById("addTopicInput")?.value||"").trim();
  if (!val){toast("Topic cannot be empty.","warning");return;}
  if (!currentFile){toast("Select a file first.","warning");return;}
  const td=topicsData[currentFile];
  if(td.remaining.includes(val)||td.covered.includes(val)){toast("Already exists.","warning");return;}
  td.remaining.push(val);
  saveToStorage(); renderTopicList(); renderInsights(); updateQuickStats();
  closeModal("addTopicModal"); toast(`"${val}" added!`,"success");
}

/* ═══════════════════════════════════════════════════════════════
   AI FEATURES — calls Vercel backend (API key is server-side)
═══════════════════════════════════════════════════════════════ */

/**
 * callBackend — POST to a Vercel API route, parse JSON response.
 * Throws if BACKEND_URL is not configured or server returns error.
 */
async function callBackend(endpoint, body) {
  if (BACKEND_URL.includes("YOUR_VERCEL_APP")) {
    throw new Error("BACKEND_URL is not set in app.js. Deploy the backend to Vercel first, then paste the URL.");
  }
  const resp = await fetch(`${BACKEND_URL}${endpoint}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(90_000)  // 90 sec for large PDFs
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || `Server error ${resp.status}`);
  return data;
}

// ── Extract Topics
async function extractTopics() {
  if (!currentFile) { toast("Select a file in the sidebar first.", "warning"); return; }
  const btn = document.getElementById("aiTopicsBtn");
  btn.disabled=true; btn.innerHTML='<div class="spinner"></div> Extracting…';
  try {
    const dataUrl = await getPDFFromIDB(idbKey(currentFile));
    if (!dataUrl) { toast("PDF not found. Re-upload the file.", "error"); return; }
    toast("Sending to Gemini AI — 10–30 seconds…");
    const data = await callBackend("/api/extract-topics", {
      pdfBase64: dataUrl.split(",")[1],
      fileName:  currentFile
    });
    const td = topicsData[currentFile];
    let added = 0;
    data.topics.forEach(t => {
      if (!td.remaining.includes(t) && !td.covered.includes(t)) { td.remaining.push(t); added++; }
    });
    saveToStorage(); renderTopicList(); renderInsights(); updateQuickStats();
    toast(`✓ ${data.topics.length} topics extracted (${added} new)!`, "success");
  } catch(err) {
    toast("AI failed: " + err.message, "error"); console.error("[extractTopics]", err);
  } finally {
    btn.disabled=false; btn.innerHTML="🤖 AI Extract Topics";
  }
}

// ── Generate Summary
async function generateSummary() {
  if (!currentFile) { toast("Open a file first.", "warning"); return; }
  const summaryBox     = document.getElementById("summaryBox");
  const summaryContent = document.getElementById("summaryContent");
  summaryBox.style.display    = "block";
  summaryContent.innerHTML    = '<div class="ai-thinking"><div class="spinner"></div> Generating summary — may take 15–40 seconds…</div>';
  summaryBox.scrollIntoView({ behavior:"smooth", block:"nearest" });
  const btn = document.getElementById("aiSummaryBtn");
  btn.disabled=true; btn.innerHTML='<div class="spinner"></div>';
  try {
    const dataUrl = await getPDFFromIDB(idbKey(currentFile));
    if (!dataUrl) { toast("PDF not found. Re-upload.", "error"); summaryBox.style.display="none"; return; }
    const data = await callBackend("/api/summary", {
      pdfBase64: dataUrl.split(",")[1],
      fileName:  currentFile
    });
    // Convert markdown to HTML
    const html = data.summary
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g,     "<em>$1</em>")
      .replace(/^#{1,3}\s+(.+)$/gm,"<h4 style='margin:14px 0 5px;color:var(--text);'>$1</h4>")
      .replace(/^[•\-]\s+(.+)$/gm,"<span style='display:block;margin:3px 0;'>• $1</span>")
      .replace(/\n\n/g,"<br/><br/>").replace(/\n/g,"<br/>");
    summaryContent.innerHTML = html;
    toast("Summary ready!", "success");
  } catch(err) {
    summaryContent.innerHTML=`<span style="color:var(--red);">Failed: ${escHtml(err.message)}</span>`;
    toast("Summary failed: "+err.message,"error");
  } finally {
    btn.disabled=false; btn.innerHTML="✨ AI Summary";
  }
}

/* ═══════════════════════════════════════════════════════════════
   INSIGHTS
═══════════════════════════════════════════════════════════════ */
function getAggregateStats() {
  const files = Object.keys(uploadedFiles);
  let totalTopics=0,totalCovered=0,totalImportant=0;
  files.forEach(fn=>{const td=topicsData[fn]||{remaining:[],covered:[],important:[]};totalTopics+=td.remaining.length+td.covered.length;totalCovered+=td.covered.length;totalImportant+=td.important.length;});
  const pct=totalTopics?Math.round(totalCovered/totalTopics*100):0;
  return{files,totalTopics,totalCovered,totalImportant,pct};
}

function updateQuickStats() {
  const{files,totalTopics,totalCovered,pct}=getAggregateStats();
  const s=id=>document.getElementById(id);
  if(s("qs-files"))  s("qs-files").textContent=files.length;
  if(s("qs-topics")) s("qs-topics").textContent=totalTopics;
  if(s("qs-covered"))s("qs-covered").textContent=totalCovered;
  if(s("qs-pct"))    s("qs-pct").textContent=pct+"%";
}

function renderInsights() {
  const{files,totalTopics,totalCovered,totalImportant,pct}=getAggregateStats();
  const grid=document.getElementById("insightsGrid");
  if(grid){grid.innerHTML=[
    {val:files.length,label:"Files",barPct:Math.min(files.length/MAX_FILES_GUEST*100,100),barClass:"blue"},
    {val:totalTopics,label:"Total Topics",barPct:null},
    {val:totalCovered,label:"Covered",barPct:pct,barClass:"green"},
    {val:totalTopics-totalCovered,label:"Remaining",barPct:null},
    {val:totalImportant,label:"Important",barPct:null},
    {val:pct+"%",label:"Overall Progress",barPct:pct,barClass:""}
  ].map(c=>`<div class="insight-card"><div class="insight-value">${c.val}</div><div class="insight-label">${c.label}</div>${c.barPct!==null?`<div class="progress-bar-wrap"><div class="progress-bar"><div class="progress-fill ${c.barClass||""}" style="width:${c.barPct}%"></div></div></div>`:""}</div>`).join("");}

  const pfb=document.getElementById("fileProgressBars");
  if(pfb){pfb.innerHTML=!files.length?'<div class="empty-state small"><p>No files yet.</p></div>':files.map(fn=>{const td=topicsData[fn]||{remaining:[],covered:[]};const tot=td.remaining.length+td.covered.length;const cov=td.covered.length;const p=tot?Math.round(cov/tot*100):0;return`<div class="file-progress-row"><div class="file-progress-meta"><span class="file-progress-name" title="${escHtml(fn)}">${escHtml(fn)}</span><span class="file-progress-stat">${cov}/${tot}·${p}%</span></div><div class="progress-bar" style="height:8px;"><div class="progress-fill green" style="width:${p}%"></div></div></div>`;}).join("");}

  const bc=document.getElementById("topicsBarChart");
  if(bc){if(!files.length){bc.innerHTML='<p style="color:var(--text-light);font-size:13px;">No data.</p>';}else{const maxT=Math.max(1,...files.map(fn=>{const td=topicsData[fn]||{remaining:[],covered:[]};return td.remaining.length+td.covered.length;}));bc.innerHTML=files.map(fn=>{const td=topicsData[fn]||{remaining:[],covered:[]};const tot=td.remaining.length+td.covered.length;const h=Math.max(6,Math.round(tot/maxT*110));const lbl=fn.length>13?fn.slice(0,11)+"…":fn;return`<div class="bar-item" title="${escHtml(fn)}:${tot}"><div class="bar-col" style="height:${h}px;"></div><span class="bar-label">${escHtml(lbl)}</span></div>`;}).join("");}}

  const itl=document.getElementById("importantTopicsList");
  if(itl){let html="";files.forEach(fn=>(topicsData[fn]?.important||[]).forEach(t=>{html+=`<span class="chip important" title="${escHtml(fn)}">★ ${escHtml(t)}</span>`;}));itl.innerHTML=html||'<p style="color:var(--text-light);font-size:13px;">No important topics yet.</p>';}
  updateQuickStats();
}

/* ═══════════════════════════════════════════════════════════════
   CONTACT FORM
═══════════════════════════════════════════════════════════════ */
async function submitContact() {
  const name =document.getElementById("contactName")?.value.trim();
  const email=document.getElementById("contactEmail")?.value.trim();
  const msg  =document.getElementById("contactMsg")?.value.trim();
  if(!name||!email||!msg){toast("Fill in all fields.","warning");return;}
  if(!email.includes("@")){toast("Enter a valid email.","warning");return;}
  const btn=document.querySelector(".contact-submit-btn");
  if(btn){btn.disabled=true;btn.textContent="Sending…";}
  try{
    if(FORMSPREE_URL.includes("YOUR_FORM_ID")){await new Promise(r=>setTimeout(r,700));toast("Demo mode — set FORMSPREE_URL in app.js.","warning");}
    else{const r=await fetch(FORMSPREE_URL,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({name,email,message:msg})});if(!r.ok)throw new Error("Submission failed.");toast("Message sent!","success");}
    ["contactName","contactEmail","contactMsg"].forEach(id=>{const el=document.getElementById(id);if(el)el.value="";});
  }catch(err){toast("Failed: "+err.message,"error");}
  finally{if(btn){btn.disabled=false;btn.textContent="Send Message →";}}
}

/* ═══════════════════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════════════════ */
function toast(msg,type=""){
  const c=document.getElementById("toastContainer");if(!c)return;
  const el=document.createElement("div");
  el.className=`toast ${type}`;el.innerHTML=`<span>${escHtml(msg)}</span>`;
  c.appendChild(el);
  setTimeout(()=>{el.style.transition="opacity .3s,transform .3s";el.style.opacity="0";el.style.transform="translateX(110%)";setTimeout(()=>el.remove(),320);},3200);
}

/* ═══════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════ */
function escHtml(str){return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");}
function escAttr(str){return String(str).replace(/\\/g,"\\\\").replace(/'/g,"\\'");}
