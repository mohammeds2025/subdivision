/********  server.js  (SSE + Progress + Merge + Auto‑Open)  ********/
const express = require('express');
const fetch   = global.fetch || ((...a)=>import('node-fetch').then(({default:f})=>f(...a)));
const { Agent } = require('http');
const { PDFDocument } = require('pdf-lib');

const app  = express();
const PORT = 3000;

/* ---- keep‑alive Agent ---- */
const agent = new Agent({ keepAlive:true, maxSockets:64 });

app.use(express.json({limit:'1mb'}));   /* لتلقّي JSON صغير */

/* ---------- دالّة فحص رابط واحد (GET + Range) ---------- */
async function checkLink(rec, url){
  try{
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'Range': 'bytes=0-0' },   // يحمل أوّل بايت فقط
      agent,
      timeout: 10000
    });

    /* 1) نوع المحتوى */
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (/application\/pdf/.test(ct)) return { rec, isDoc:true };

    /* 2) اسم الملف */
    const cd = (r.headers.get('content-disposition') || '').toLowerCase();
    if (/\.pdf\b/.test(cd)) return { rec, isDoc:true };

    /* 3) توقيع PDF %PDF- */
    const buf = await r.arrayBuffer();
    if (buf.byteLength && new Uint8Array(buf)[0] === 0x25) return { rec, isDoc:true };

    return { rec, isDoc:false };
  }catch{
    return { rec, isDoc:false };
  }
}

/* ---------- بث SSE للفحص ---------- */
app.get('/stream', async (req, res) => {
  const { order, start, end } = req.query;
  const s = +start, e = +end;
  if (!order || isNaN(s) || isNaN(e) || s>e){
    res.status(400).end('bad params'); return;
  }

  res.setHeader('Content-Type','text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  const total = e - s + 1;
  res.write(`event: meta\ndata: ${total}\n\n`);

  const limit = 32;          // عدد الروابط المتوازية
  let cursor  = s;

  async function worker(){
    while (cursor <= e){
      const rec = cursor++;
      const url = `https://subdivision-services.rega.gov.sa/v/${order}/${rec}/30f8392c7677d6b404be0e2f5110b27b`;
      const { isDoc } = await checkLink(rec, url);
      res.write(`event: result\ndata: ${rec}|${isDoc}\n\n`);
    }
  }
  await Promise.all(Array.from({length:limit}, worker));
  res.write('event: done\ndata: done\n\n');
  res.end();
});

/* ---------- مسار الدمج ---------- */
app.post('/merge', async (req, res) => {
  const { order, list } = req.body || {};
  if (!order || !Array.isArray(list) || !list.length){
    return res.status(400).json({ ok:false, msg:'bad body' });
  }

  const merged = await PDFDocument.create();
  for (const rec of list){
    const url = `https://subdivision-services.rega.gov.sa/v/${order}/${rec}/30f8392c7677d6b404be0e2f5110b27b`;
    try{
      const r   = await fetch(url, { agent, timeout:15000 });
      const buf = await r.arrayBuffer();
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }catch(e){
      console.error('skip', rec, e.message);
    }
  }
  const pdfBytes = await merged.save();
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition','attachment; filename="merged.pdf"');
  res.send(Buffer.from(pdfBytes));
});

/* ---------- واجهة HTML ---------- */
const page = `<!DOCTYPE html><html lang="ar"><meta charset="utf-8">
<title>محاضر فرز الوحدات</title>
<style>
body{font-family:cairo,arial;direction:rtl;padding:25px;background:#eef2ff;}
.container{max-width:650px;margin:auto;background:#fff;padding:25px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.08);}
input{padding:8px 12px;border:1px solid #ccc;border-radius:8px;width:110px;text-align:center;margin:4px;}
button{padding:9px 22px;background:#28a745;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer}
#wrap{margin-top:18px}
#prog{height:16px;background:#e0e0e0;border-radius:10px;overflow:hidden}
#prog span{display:block;height:100%;width:0;background:#28a745}
#pct{margin-top:4px;font-size:13px;color:#444}
a{display:block;margin:6px 0;color:#007bff;font-weight:bold;text-decoration:none}
#download{display:none;margin-top:14px;background:#007bff}
</style>
<div class="container">
<h2>محاضر فرز الوحدات</h2>
<label>رقم الطلب:</label><input id="o" type="text">
<label>من:</label><input id="s" type="text" placeholder="1">
<label>إلى:</label><input id="e" type="text" placeholder="5">
<button id="go">عرض</button>

<div id="wrap" style="display:none">
  <div id="prog"><span></span></div>
  <div id="pct">0 %</div>
</div>

<button id="download">تحميل الملف المدمج</button>
<div id="out"></div>
</div>

<script>
const btnGo=document.getElementById('go');
const btnDl=document.getElementById('download');
btnGo.onclick = () => {
  const order=document.getElementById('o').value.trim();
  const s=+document.getElementById('s').value, e=+document.getElementById('e').value;
  if(!order||isNaN(s)||isNaN(e)||s>e) return alert('بيانات غير صحيحة.');

  const bar=document.querySelector('#prog span');
  const pct=document.getElementById('pct');
  const wrap=document.getElementById('wrap');
  const out=document.getElementById('out');
  bar.style.width='0%'; pct.textContent='0 %';
  out.innerHTML=''; wrap.style.display='block'; btnDl.style.display='none';

  const good=[]; let total=0, done=0;
  const es=new EventSource(\`/stream?order=\${order}&start=\${s}&end=\${e}\`);
  es.addEventListener('meta',e=>total=+e.data);
  es.addEventListener('result',e=>{
    done++;
    const [rec,isDoc]=e.data.split('|');
    const pc=Math.round(100*done/total);
    bar.style.width=pc+'%'; pct.textContent=pc+' %';
    if(isDoc==='true'){
      good.push(rec);
      const a=document.createElement('a');
      a.href=\`https://subdivision-services.rega.gov.sa/v/\${order}/\${rec}/30f8392c7677d6b404be0e2f5110b27b\`;
      a.target='_blank'; a.textContent=\`\${good.length}- محضر رقم \${rec} (ملف)\`;
      out.appendChild(a);
    }
  });
  es.addEventListener('done',()=>{
    es.close();
    if(!good.length){ out.textContent='لا ملفات رقمية.'; return; }
    btnDl.style.display='inline-block';
    btnDl.onclick = async ()=>{
      btnDl.disabled=true; btnDl.textContent='يتم التحميل…';
      const r=await fetch('/merge',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({order,list:good})});
      const blob=await r.blob();
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');
      link.href=url; link.download='merged.pdf'; link.click();
      URL.revokeObjectURL(url);
      btnDl.disabled=false; btnDl.textContent='تحميل الملف المدمج';
    };
  });
};
</script>`;

/* ---------- تقديم الصفحة ---------- */
app.get('/',(_,res)=>res.sendFile(__dirname + '/index.html'));

/* ---------- تشغيل الخادم + فتح المتصفّح ---------- */
function openBrowser(url){
  const { exec } = require('child_process');
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin'? `open "${url}"` :
                                   `xdg-open "${url}"`;
  exec(cmd);
}
app.listen(PORT,()=>{ const url=`http://localhost:${PORT}`; console.log('PDF‑merge server on '+url); openBrowser(url); });
