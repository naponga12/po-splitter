/*
 * app.js — PO Splitter
 * อ่าน PDF → แสดงทีละหน้า → OCR หาเลข PO + สินค้ารายการแรก → ให้ผู้ใช้ตรวจ/แก้ → แยกไฟล์และตั้งชื่อ
 */
(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const LOG = window.UsageLog;
  const P = window.POParser;
  const BASE = new URL('.', location.href).href;

  pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'vendor/pdf.worker.min.js';

  const OCR_WIDTH = 2000;      // ความกว้างภาพที่ใช้ OCR (px)
  const OCR_TOP_RATIO = 0.62;  // OCR เฉพาะส่วนบนของหน้า (หัวเอกสาร + ตารางรายการ)
  const STRIP_RATIO = 0.05;    // ความสูงแถบแถวรายการแรก (รอบสอง)

  const state = { files: [], pages: [], queue: [], running: false, uid: 0 };

  // ---------------- DOM ----------------
  const $ = s => document.querySelector(s);
  const el = {
    drop: $('#dropzone'), input: $('#fileInput'), ws: $('#workspace'), cards: $('#cards'),
    tpl: $('#cardTpl'), zip: $('#btnZip'), add: $('#btnAdd'), clear: $('#btnClear'),
    sumFiles: $('#sumFiles'), sumPages: $('#sumPages'), sumDocs: $('#sumDocs'),
    progWrap: $('#progressWrap'), progBar: $('#progressBar'), progText: $('#progressText'),
    dlg: $('#previewDlg'), dlgCanvas: $('#previewCanvas'), dlgTitle: $('#previewTitle'),
    toast: $('#toast'),
  };
  $('#deviceId').textContent = LOG ? LOG.deviceId : '-';

  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.toast.hidden = true; }, ms || 3000);
  }

  // ---------------- รับไฟล์ ----------------
  el.drop.addEventListener('click', () => el.input.click());
  el.drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') el.input.click(); });
  el.add.addEventListener('click', () => el.input.click());
  el.input.addEventListener('change', () => { addFiles([...el.input.files]); el.input.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => {
    e.preventDefault(); el.drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => {
    e.preventDefault(); el.drop.classList.remove('over');
  }));
  document.addEventListener('drop', e => addFiles([...(e.dataTransfer.files || [])]));

  async function addFiles(list) {
    const pdfs = list.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!pdfs.length) { if (list.length) toast('รองรับเฉพาะไฟล์ PDF'); return; }
    el.ws.hidden = false;
    el.ws.prepend(el.drop);
    for (const f of pdfs) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        // pdf.js อาจย้าย buffer ไป worker จึงส่งสำเนา
        const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
        const file = { id: ++state.uid, name: f.name, size: f.size, bytes, pdf, pageCount: pdf.numPages, ocrStart: 0, pdfLib: null };
        state.files.push(file);
        LOG && LOG.send('file_upload', { fileName: f.name, pages: pdf.numPages, details: { sizeKB: Math.round(f.size / 1024) } });
        if (LOG) { LOG.stats.files++; LOG.stats.pages += pdf.numPages; }
        for (let i = 0; i < pdf.numPages; i++) {
          const p = {
            uid: ++state.uid, file, index: i, po: '', item: '', ocrPo: '', ocrItem: '',
            poEdited: false, itemEdited: false, status: 'wait', joinPrev: false, skip: false, el: null,
          };
          state.pages.push(p);
          createCard(p);
          state.queue.push(p);
        }
        renderThumbs(file);
      } catch (err) {
        console.error(err);
        toast(`เปิดไฟล์ ${f.name} ไม่ได้: ${err.message}`, 5000);
        LOG && LOG.send('error', { fileName: f.name, details: { stage: 'open', message: String(err.message || err) } });
      }
    }
    refresh();
    runQueue();
  }

  // ---------------- แสดงผล ----------------
  async function renderPage(file, index, width) {
    const page = await file.pdf.getPage(index + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / vp1.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }

  async function renderThumbs(file) {
    for (const p of state.pages.filter(x => x.file === file)) {
      try {
        const c = await renderPage(file, p.index, 220);
        p.el.querySelector('.thumb img').src = c.toDataURL('image/jpeg', 0.8);
      } catch (e) { console.warn(e); }
    }
  }

  function createCard(p) {
    const node = el.tpl.content.firstElementChild.cloneNode(true);
    p.el = node;
    node.querySelector('.pg').textContent = `หน้า ${p.index + 1}`;
    node.querySelector('.src').textContent = `${p.file.name} · หน้า ${p.index + 1}/${p.file.pageCount}`;
    node.querySelector('.src').title = p.file.name;
    const join = node.querySelector('.joinPrev');
    if (p.index === 0) join.closest('label').style.visibility = 'hidden';

    const po = node.querySelector('.po');
    const item = node.querySelector('.item');
    po.addEventListener('input', () => { p.po = po.value; p.poEdited = true; refresh(); });
    item.addEventListener('input', () => { p.item = item.value; p.itemEdited = true; refresh(); });
    join.addEventListener('change', () => { p.joinPrev = join.checked; refresh(); });
    node.querySelector('.skip').addEventListener('change', e => { p.skip = e.target.checked; refresh(); });
    node.querySelector('.thumb').addEventListener('click', () => preview(p));
    node.querySelector('.dl').addEventListener('click', () => downloadSingle(p));
    node.querySelector('.rerun').addEventListener('click', () => {
      p.poEdited = p.itemEdited = false;
      p.status = 'wait';
      if (!state.queue.includes(p)) state.queue.push(p);
      updateCard(p);
      runQueue();
    });
    el.cards.appendChild(node);
    updateCard(p);
  }

  const STATUS_TEXT = {
    wait: 'รอคิวอ่านข้อความ',
    busy: 'กำลังอ่านข้อความ…',
    ok: '✓ อ่านได้ — ตรวจตัวสะกดอีกครั้ง',
    partial: '⚠ อ่านได้บางส่วน — โปรดตรวจ',
    err: '✕ อ่านไม่ได้ — กรอกเอง หรือถ้าเป็นหน้าต่อ ให้ติ๊ก “ต่อจากหน้าก่อน”',
  };

  function updateCard(p) {
    const n = p.el;
    const po = n.querySelector('.po');
    const item = n.querySelector('.item');
    if (document.activeElement !== po) po.value = p.po;
    if (document.activeElement !== item) item.value = p.item;
    const done = p.status !== 'wait' && p.status !== 'busy';
    po.classList.toggle('missing', done && !p.po.trim());
    item.classList.toggle('missing', done && !p.item.trim());
    po.classList.toggle('edited', p.po !== p.ocrPo && done);
    item.classList.toggle('edited', p.item !== p.ocrItem && done);
    const st = n.querySelector('.status');
    st.textContent = STATUS_TEXT[p.status] || '';
    st.className = 'status ' + ({ busy: 'busy', ok: 'ok', err: 'err' }[p.status] || '');
    n.querySelector('.rerun').disabled = p.status === 'busy' || p.status === 'wait';
  }

  // ---------------- เอกสาร (กลุ่มหน้า) และชื่อไฟล์ ----------------
  function getDocs() {
    const docs = [];
    let cur = null;
    for (const p of state.pages) {
      if (p.joinPrev && cur && cur.file === p.file) cur.all.push(p);
      else { cur = { head: p, file: p.file, all: [p] }; docs.push(cur); }
    }
    docs.forEach(d => { d.pages = d.head.skip ? [] : d.all.filter(p => !p.skip); });
    return docs;
  }

  function baseName(doc) {
    return P.buildFileName(doc.head.po, doc.head.item, cfg.MAX_ITEM_LEN || 80)
      .replace(' - ', cfg.NAME_SEPARATOR || ' - ');
  }

  function assignNames(docs) {
    const used = new Map();
    docs.forEach(d => {
      if (!d.pages.length) { d.name = ''; return; }
      let name = baseName(d);
      const key = name.toLowerCase();
      const n = (used.get(key) || 0) + 1;
      used.set(key, n);
      if (n > 1) name = name.replace(/\.pdf$/i, ` (${n}).pdf`);
      d.name = name;
    });
    return docs;
  }

  function refresh() {
    const docs = assignNames(getDocs());
    const active = docs.filter(d => d.pages.length);
    for (const p of state.pages) {
      const joined = p.joinPrev && p.index > 0;
      p.el.classList.toggle('joined', joined);
      p.el.classList.toggle('skipped', p.skip);
    }
    for (const d of docs) {
      const n = d.head.el;
      const extra = d.all.length > 1 ? ` (${d.pages.length} หน้า)` : '';
      n.querySelector('.fname').textContent = d.name ? d.name + extra : '— ไม่ส่งออก —';
      n.querySelector('.fname').title = d.name;
      n.querySelector('.dl').disabled = !d.pages.length;
      updateCard(d.head);
    }
    el.sumFiles.textContent = `${state.files.length} ไฟล์`;
    el.sumPages.textContent = `${state.pages.length} หน้า`;
    el.sumDocs.textContent = `${active.length} เอกสาร`;
    el.zip.disabled = !active.length;
  }

  // ---------------- OCR ----------------
  let w1 = null, w2 = null;
  function makeWorker(psm) {
    return Tesseract.createWorker(cfg.OCR_LANG || 'tha+eng', 1, {
      workerPath: BASE + 'vendor/tesseract/worker.min.js',
      corePath: BASE + 'vendor/tesseract/tesseract-core-simd-lstm.js',
      workerBlobURL: false, // ให้ worker หาไฟล์ .wasm ในโฟลเดอร์เดียวกันได้
      langPath: BASE + 'vendor/tesseract/lang',
      gzip: true,
    }).then(async w => {
      const params = { preserve_interword_spaces: '1' };
      if (psm) params.tessedit_pageseg_mode = psm;
      await w.setParameters(params);
      return w;
    });
  }
  const getW1 = () => (w1 = w1 || makeWorker());
  const getW2 = () => (w2 = w2 || makeWorker('6'));

  // แถบแถวรายการแรก: ขยาย 2 เท่า, เพิ่ม contrast, ทำขาวดำ, ลบเส้นตาราง
  function makeStrip(src, top, height) {
    const W = src.width * 2, H = height * 2;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, top, src.width, height, 0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const gray = new Uint8ClampedArray(W * H);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      gray[j] = g; hist[gray[j]]++;
    }
    const pct = q => { let acc = 0; const lim = gray.length * q; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lim) return v; } return 255; };
    const lo = pct(0.02), hi = pct(0.98), span = Math.max(1, hi - lo);
    const bin = new Uint8Array(W * H);
    const colDark = new Uint32Array(W), rowDark = new Uint32Array(H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const j = y * W + x;
      const v = ((gray[j] - lo) / span) * 255;
      if (v < 170) { bin[j] = 1; colDark[x]++; rowDark[y]++; }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const j = y * W + x, i = j * 4;
      const dark = bin[j] && colDark[x] <= H * 0.6 && rowDark[y] <= W * 0.5;
      d[i] = d[i + 1] = d[i + 2] = dark ? 0 : 255; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  async function ocrPage(p) {
    p.status = 'busy';
    updateCard(p);
    const full = await renderPage(p.file, p.index, OCR_WIDTH);
    const crop = document.createElement('canvas');
    crop.width = full.width;
    crop.height = Math.round(full.height * OCR_TOP_RATIO);
    crop.getContext('2d').drawImage(full, 0, 0);

    const { data } = await (await getW1()).recognize(crop);
    let { po, item } = P.parse(data);

    if (!item) { // รอบสอง: OCR เฉพาะแถวรายการแรก
      const hb = P.findHeaderBottom(data);
      if (hb > 0) {
        const h = Math.round(full.height * STRIP_RATIO);
        const r2 = await (await getW2()).recognize(makeStrip(full, Math.min(hb + 4, full.height - h), h));
        item = P.findItemInStrip(r2.data.text);
      }
    }
    p.ocrPo = po; p.ocrItem = item;
    if (!p.poEdited) p.po = po;
    if (!p.itemEdited) p.item = item;
    p.status = po && item ? 'ok' : (po || item ? 'partial' : 'err');
  }

  async function runQueue() {
    if (state.running) return;
    state.running = true;
    let done = 0;
    el.progWrap.hidden = false;
    while (state.queue.length) {
      const total = done + state.queue.length;
      el.progBar.style.width = `${(done / total) * 100}%`;
      el.progText.textContent = done === 0 && !w1
        ? 'กำลังโหลดตัวอ่านภาษาไทย (ครั้งแรกอาจใช้เวลาสักครู่)…'
        : `กำลังอ่านข้อความ ${done + 1}/${total} หน้า…`;
      const p = state.queue.shift();
      if (!state.pages.includes(p)) continue; // ถูกล้างไปแล้ว
      if (!p.file.ocrStart) p.file.ocrStart = performance.now();
      try {
        await ocrPage(p);
      } catch (err) {
        console.error(err);
        p.status = 'err';
        LOG && LOG.send('error', { fileName: p.file.name, details: { stage: 'ocr', page: p.index + 1, message: String(err.message || err) } });
      }
      done++;
      refresh();
      maybeLogFileDone(p.file);
    }
    el.progBar.style.width = '100%';
    el.progText.textContent = 'อ่านข้อความเสร็จแล้ว ตรวจชื่อไฟล์ก่อนดาวน์โหลด';
    setTimeout(() => { if (!state.running) el.progWrap.hidden = true; }, 4000);
    state.running = false;
  }

  function maybeLogFileDone(file) {
    const pages = state.pages.filter(p => p.file === file);
    if (file.ocrLogged || pages.some(p => p.status === 'wait' || p.status === 'busy')) return;
    file.ocrLogged = true;
    LOG && LOG.send('ocr_complete', {
      fileName: file.name, pages: pages.length,
      details: {
        seconds: Math.round((performance.now() - file.ocrStart) / 100) / 10,
        complete: pages.filter(p => p.status === 'ok').length,
        partial: pages.filter(p => p.status === 'partial').length,
        failed: pages.filter(p => p.status === 'err').length,
        poNumbers: pages.map(p => p.ocrPo).filter(Boolean),
      },
    });
  }

  // ---------------- แยกไฟล์ / ดาวน์โหลด ----------------
  async function buildPdf(doc) {
    const f = doc.file;
    if (!f.pdfLib) f.pdfLib = await PDFLib.PDFDocument.load(f.bytes, { ignoreEncryption: true });
    const out = await PDFLib.PDFDocument.create();
    const copied = await out.copyPages(f.pdfLib, doc.pages.map(p => p.index));
    copied.forEach(pg => out.addPage(pg));
    out.setTitle(doc.name.replace(/\.pdf$/i, ''));
    out.setProducer('PO Splitter');
    return out.save();
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function exportDetails(docs, mode) {
    const pagesOf = docs.flatMap(d => d.pages);
    return {
      fileName: [...new Set(docs.map(d => d.file.name))].join(', '),
      pages: pagesOf.length,
      docs: docs.length,
      details: {
        mode,
        exportedFiles: docs.map(d => d.name),
        manualPoEdits: docs.filter(d => d.head.po !== d.head.ocrPo).length,
        manualItemEdits: docs.filter(d => d.head.item !== d.head.ocrItem).length,
        multiPageDocs: docs.filter(d => d.pages.length > 1).length,
        skippedPages: state.pages.filter(p => p.skip).length,
        missingPo: docs.filter(d => !d.head.po.trim()).length,
      },
    };
  }

  async function downloadSingle(p) {
    const docs = assignNames(getDocs());
    const doc = docs.find(d => d.head === p);
    if (!doc || !doc.pages.length) return;
    try {
      const bytes = await buildPdf(doc);
      saveBlob(new Blob([bytes], { type: 'application/pdf' }), doc.name);
      LOG && LOG.send('export', exportDetails([doc], 'single'));
      if (LOG) { LOG.stats.exports++; LOG.stats.docsExported++; }
    } catch (err) {
      toast('สร้างไฟล์ไม่สำเร็จ: ' + err.message, 5000);
      LOG && LOG.send('error', { fileName: p.file.name, details: { stage: 'export_single', message: String(err.message || err) } });
    }
  }

  el.zip.addEventListener('click', async () => {
    const docs = assignNames(getDocs()).filter(d => d.pages.length);
    if (!docs.length) return;
    if (state.running && !confirm('ระบบยังอ่านข้อความไม่ครบทุกหน้า ต้องการดาวน์โหลดเลยหรือไม่?')) return;
    const noPo = docs.filter(d => !d.head.po.trim()).length;
    if (noPo && !confirm(`มี ${noPo} เอกสารที่ยังไม่มีเลข PO ต้องการดาวน์โหลดต่อหรือไม่?`)) return;
    el.zip.disabled = true;
    const label = el.zip.textContent;
    try {
      const zip = new JSZip();
      for (let i = 0; i < docs.length; i++) {
        el.zip.textContent = `กำลังสร้าง ${i + 1}/${docs.length}…`;
        zip.file(docs[i].name, await buildPdf(docs[i]));
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      saveBlob(blob, `PO_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.zip`);
      LOG && LOG.send('export', exportDetails(docs, 'zip'));
      if (LOG) { LOG.stats.exports++; LOG.stats.docsExported += docs.length; }
      toast(`ดาวน์โหลด ${docs.length} ไฟล์แล้ว`);
    } catch (err) {
      console.error(err);
      toast('สร้างไฟล์ ZIP ไม่สำเร็จ: ' + err.message, 5000);
      LOG && LOG.send('error', { details: { stage: 'export_zip', message: String(err.message || err) } });
    } finally {
      el.zip.textContent = label;
      el.zip.disabled = false;
    }
  });

  el.clear.addEventListener('click', () => {
    if (!state.pages.length) return;
    if (!confirm('ล้างไฟล์ทั้งหมดออกจากหน้านี้?')) return;
    LOG && LOG.send('clear', { pages: state.pages.length, docs: getDocs().length, details: { files: state.files.map(f => f.name) } });
    state.files.forEach(f => f.pdf.destroy());
    state.files = []; state.pages = []; state.queue = [];
    el.cards.innerHTML = '';
    el.ws.hidden = true;
    document.querySelector('main').prepend(el.drop);
    refresh();
  });

  // ---------------- ดูตัวอย่าง ----------------
  async function preview(p) {
    el.dlgTitle.textContent = `${p.file.name} — หน้า ${p.index + 1}`;
    el.dlg.showModal();
    const c = await renderPage(p.file, p.index, Math.min(1100, window.innerWidth * 0.9));
    el.dlgCanvas.width = c.width; el.dlgCanvas.height = c.height;
    el.dlgCanvas.getContext('2d').drawImage(c, 0, 0);
  }
  $('#previewClose').addEventListener('click', () => el.dlg.close());
  el.dlg.addEventListener('click', e => { if (e.target === el.dlg) el.dlg.close(); });

  // สำหรับทดสอบอัตโนมัติ
  window.__poApp = { state, getDocs: () => assignNames(getDocs()), addFiles };
})();
