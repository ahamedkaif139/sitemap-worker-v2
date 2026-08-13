const MAX_BATCH = 20;             // sitemap XML fetches per Worker call
const CACHE_TTL = 86400;          // 24 hours
const MAX_UPSTREAM_BYTES = 60 * 1024 * 1024; // 60MB safety cap per sitemap file

// ---- SSRF guard: block loopback / private / link-local hosts ----
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i,
  /\.local$/i,
  /\.internal$/i
];

function isPrivateHost(hostname) {
  return PRIVATE_HOST_PATTERNS.some(re => re.test(hostname));
}

function validTarget(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (!u.hostname) return false;
    if (isPrivateHost(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sitemap XML \u2192 CSV (ZIP) \u2014 Any Website</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f5f7fb;color:#172033}
.wrap{max-width:1050px;margin:30px auto;padding:0 16px}
.card{background:#fff;border:1px solid #e3e7ef;border-radius:16px;padding:22px;margin-bottom:16px;box-shadow:0 5px 20px #00000008}
h1{margin:0 0 8px;font-size:26px}
p{color:#596579}
label{font-weight:700;display:block;margin:14px 0 7px}
textarea{width:100%;min-height:200px;padding:13px;border:1px solid #ccd3df;border-radius:10px;font:14px ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical}
select,input[type=number]{padding:9px 10px;border:1px solid #ccd3df;border-radius:8px;font:14px system-ui}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;align-items:center}
button{border:0;border-radius:10px;padding:11px 16px;font-weight:700;cursor:pointer;background:#2563eb;color:white}
button.secondary{background:#e9eef7;color:#172033}
button.danger{background:#dc2626}
button:disabled{opacity:.5;cursor:not-allowed}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.stat{background:#f7f9fc;border-radius:10px;padding:13px}
.stat b{display:block;font-size:20px}
.stat span{font-size:12px;color:#697386}
.bar{height:12px;background:#e6eaf1;border-radius:99px;overflow:hidden;margin:14px 0}
.bar>div{height:100%;width:0;background:#2563eb;transition:width .15s}
#log{max-height:340px;overflow:auto;font:13px ui-monospace,SFMono-Regular,Consolas,monospace;background:#101827;color:#dbe5f5;padding:14px;border-radius:10px;white-space:pre-wrap}
.ok{color:#76e39a}
.err{color:#ff8f8f}
.muted{color:#697386}
.hint{font-size:13px}
.pill{display:inline-block;background:#eef4ff;color:#2457c5;padding:4px 8px;border-radius:99px;font-size:12px}
@media(max-width:700px){.stats{grid-template-columns:repeat(2,1fr)}}
</style>
</head>

<body>
<div class="wrap">

<div class="card">
<h1>\uD83D\uDCE5 Sitemap XML \u2192 CSV (ZIP) \u2014 Any Website</h1>

<p>
Paste one or more sitemap-index URLs or individual XML sitemap URLs from
<b>any website</b>. The tool discovers child sitemaps automatically and
processes them in small batches. CSVs are downloaded as a series of ZIP
parts so a huge job (hundreds of sitemaps) never produces one giant,
truncated file.
</p>

<label>Sitemap / sitemap-index URL(s)</label>

<textarea id="urls" placeholder="https://example.com/sitemap_index.xml
https://example.com/sitemap-products-1.xml"></textarea>

<div class="row">
<label style="margin:0">ZIP part size</label>
<select id="chunkSize">
<option value="50">50 sitemaps / ZIP</option>
<option value="100">100 sitemaps / ZIP</option>
<option value="150" selected>150 sitemaps / ZIP (recommended)</option>
<option value="250">250 sitemaps / ZIP</option>
</select>
</div>

<div class="row">
<button id="start">Start conversion</button>
<button id="stop" class="danger" disabled>Stop</button>
<button id="clear" class="secondary">Clear</button>
</div>

<p class="hint">
<span class="pill">Fetch batch: ${MAX_BATCH}</span>
<span class="pill">Auto ZIP per part</span>
Each Worker call fetches at most ${MAX_BATCH} sitemap files. A new ZIP part
downloads automatically once it fills up, instead of holding everything in
memory until the very end. Successfully fetched sitemaps are cached for 24
hours.
</p>
</div>

<div class="card">
<div class="stats">
<div class="stat"><b id="done">0</b><span>Sitemaps done</span></div>
<div class="stat"><b id="found">0</b><span>URLs extracted</span></div>
<div class="stat"><b id="created">0</b><span>CSV files created</span></div>
<div class="stat"><b id="failed">0</b><span>Failed</span></div>
<div class="stat"><b id="parts">0</b><span>ZIP parts downloaded</span></div>
</div>

<div class="bar"><div id="progress"></div></div>
<div id="status" class="muted">Ready.</div>
</div>

<div class="card">
<h3>Activity</h3>
<div id="log">Ready.</div>
</div>

</div>

<script>
let stopped=false;

const $=id=>document.getElementById(id);

function log(msg,cls=""){
  const d=document.createElement("div");
  d.className=cls;
  d.textContent=msg;
  $("log").appendChild(d);
  $("log").scrollTop=$("log").scrollHeight;
}

function safeName(n){
  return (n||"sitemap")
    .replace(/\\.xml$/i,"")
    .replace(/[<>:"/\\\\|?*\\x00-\\x1F]/g,"-")
    .replace(/\\s+/g,"-")
    .slice(0,150)||"sitemap";
}

function csvEscape(v){
  return '"'+String(v??"").replace(/"/g,'""')+'"';
}

function makeCsvContent(urls){
  const lines=["url"];
  for(const u of urls)
    lines.push(csvEscape(u));
  return "\\uFEFF"+lines.join("\\r\\n")+"\\r\\n";
}

function extractLocs(xml){
  const doc=new DOMParser().parseFromString(xml,"application/xml");

  if(doc.querySelector("parsererror"))
    throw new Error("Invalid XML");

  const nodes=[...doc.getElementsByTagNameNS("*","loc")];
  const list=nodes.length
    ? nodes
    : [...doc.getElementsByTagName("loc")];

  const seen=new Set();
  const out=[];

  for(const n of list){
    const v=(n.textContent||"").trim();

    if(v&&!seen.has(v)){
      seen.add(v);
      out.push(v);
    }
  }

  return out;
}

function isSitemapIndex(xml){
  const doc=new DOMParser().parseFromString(xml,"application/xml");
  const roots=[...doc.children];

  return roots.some(r =>
    /sitemapindex$/i.test(r.localName||r.nodeName)
  ) || /<sitemapindex[\\s>]/i.test(xml);
}

/*
  Download one ZIP "part". Files are handed off to JSZip and
  compressed/downloaded immediately, then the array is cleared by the
  caller \u2014 so memory never has to hold more than one part's worth of
  CSV data at a time. This is what keeps big jobs (hundreds of
  sitemaps) from producing a single oversized, truncated ZIP.
*/
async function downloadZip(files,partNumber){
  if(!files.length) return;

  if(typeof JSZip==="undefined"){
    log("JSZip library failed to load.","err");
    return;
  }

  const zip=new JSZip();
  for(const f of files){
    zip.file(f.name,f.content);
  }

  const blob=await zip.generateAsync({
    type:"blob",
    compression:"DEFLATE",
    compressionOptions:{level:6}
  });

  const stamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
  const filename="sitemaps-part"+partNumber+"-"+stamp+".zip";

  const objectUrl=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=objectUrl;
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Give slow disks / mobile browsers plenty of time to finish writing
  // before the object URL is revoked.
  setTimeout(()=>{
    URL.revokeObjectURL(objectUrl);
  },180000);

  $("parts").textContent=(+$("parts").textContent)+1;

  log("\uD83D\uDCE6 "+filename+" \u2014 "+files.length+" CSV file(s)","ok");

  // Let the browser breathe / repaint between parts on huge jobs.
  await new Promise(r=>setTimeout(r,50));
}

function urlName(url,i){
  try{
    const u=new URL(url);
    const host=safeName(u.hostname);
    const p=u.pathname.split("/").filter(Boolean).pop()
      || ("sitemap-"+i);

    return host+"__"+safeName(p)+".csv";
  }catch{
    return "sitemap-"+i+".csv";
  }
}

function validChild(u){
  try{
    const x=new URL(u);
    return x.protocol==="https:"||x.protocol==="http:";
  }catch{
    return false;
  }
}

async function apiGet(url){
  const r=await fetch(
    "/api/sitemap?url="+encodeURIComponent(url)
  );

  if(!r.ok){
    let e="HTTP "+r.status;

    try{
      const j=await r.json();
      e=j.error||e;
    }catch{}

    throw new Error(e);
  }

  return r.text();
}

/*
  Streaming batch:
  Each completed sitemap is received immediately.
*/
async function apiBatchStream(urls,onItem){

  const r=await fetch("/api/batch",{
    method:"POST",
    headers:{
      "Content-Type":"application/json"
    },
    body:JSON.stringify({urls})
  });

  if(!r.ok){
    let e="HTTP "+r.status;

    try{
      const j=await r.json();
      e=j.error||e;
    }catch{}

    throw new Error(e);
  }

  if(!r.body)
    throw new Error("Streaming response not supported");

  const reader=r.body.getReader();
  const decoder=new TextDecoder();

  let buffer="";

  while(true){

    const {value,done}=await reader.read();

    if(value)
      buffer+=decoder.decode(value,{stream:!done});

    const lines=buffer.split("\\n");
    buffer=lines.pop()||"";

    for(const line of lines){

      if(!line.trim())
        continue;

      try{
        await onItem(JSON.parse(line));
      }catch(e){
        log("\u26A0 Invalid server result","err");
      }
    }

    if(done)
      break;
  }

  if(buffer.trim()){
    try{
      await onItem(JSON.parse(buffer));
    }catch{}
  }
}

async function discover(startUrls){

  const queue=[...startUrls];
  const final=[];
  const seenFinal=new Set();

  while(queue.length){

    if(stopped)
      break;

    const u=queue.shift();

    $("status").textContent=
      "Reading index/sitemap: "+u;

    log("\u2192 "+u);

    try{

      const xml=await apiGet(u);

      if(isSitemapIndex(xml)){

        const children=
          extractLocs(xml).filter(validChild);

        queue.push(...children);

        log(
          "\u21B3 Found "+
          children.length.toLocaleString()+
          " child sitemaps",
          "ok"
        );

      }else if(!seenFinal.has(u)){

        seenFinal.add(u);
        final.push({
          url:u,
          xml
        });

      }

    }catch(e){

      $("failed").textContent=
        (+$("failed").textContent)+1;

      log(
        "\u2717 "+u+" \u2014 "+e.message,
        "err"
      );
    }
  }

  return final;
}

$("start").onclick=async()=>{

  stopped=false;

  $("start").disabled=true;
  $("stop").disabled=false;

  ["done","found","created","failed","parts"]
    .forEach(id=>{
      $(id).textContent="0";
    });

  $("progress").style.width="0%";
  $("log").textContent="";

  const CHUNK_SIZE=+$("chunkSize").value||150;

  /*
    Remove duplicate starting URLs.
  */
  const starts=[
    ...new Set(
      $("urls").value
        .split(/\\r?\\n/)
        .map(x=>x.trim())
        .filter(Boolean)
        .filter(validChild)
    )
  ];

  if(!starts.length){

    log(
      "Enter one or more valid http(s) sitemap URLs.",
      "err"
    );

    $("start").disabled=false;
    $("stop").disabled=true;

    return;
  }

  // Only the current, not-yet-flushed ZIP part lives in memory.
  let csvFiles=[];
  let partNumber=0;

  async function flushIfFull(force){
    if(csvFiles.length && (force || csvFiles.length>=CHUNK_SIZE)){
      partNumber++;
      const toSend=csvFiles;
      csvFiles=[];
      $("status").textContent="Creating ZIP part "+partNumber+"\u2026";
      await downloadZip(toSend,partNumber);
    }
  }

  try{

    const direct=await discover(starts);

    /*
      Remove duplicate final sitemap URLs.
    */
    const queue=[
      ...new Set(
        direct.map(x=>x.url)
      )
    ];

    const total=queue.length;

    $("status").textContent=
      "Processing "+
      total.toLocaleString()+
      " sitemap(s)\u2026";

    for(
      let i=0;
      i<queue.length&&!stopped;
      i+=${MAX_BATCH}
    ){

      const batch=queue.slice(
        i,
        i+${MAX_BATCH}
      );

      log(
        "\u26A1 Processing batch "+
        (Math.floor(i/${MAX_BATCH})+1)+
        " \u2014 "+
        batch.length+
        " sitemaps"
      );

      await apiBatchStream(
        batch,
        async item=>{

          if(stopped)
            return;

          const n=item.url;

          if(item.error){

            $("failed").textContent=
              (+$("failed").textContent)+1;

            log(
              "\u2717 "+n+" \u2014 "+item.error,
              "err"
            );

          }else{

            try{

              const urls=
                extractLocs(item.xml);

              const filename=
                urlName(
                  n,
                  i+(+$("done").textContent)
                );

              csvFiles.push({
                name:filename,
                content:makeCsvContent(urls)
              });

              $("found").textContent=
                (+$("found").textContent)+
                urls.length;

              $("created").textContent=
                (+$("created").textContent)+1;

              log(
                "\u2713 "+filename+
                " \u2014 "+
                urls.length.toLocaleString()+
                " URLs",
                "ok"
              );

              // Flush a completed ZIP part as soon as it's full,
              // instead of waiting for the whole job to finish.
              await flushIfFull(false);

            }catch(e){

              $("failed").textContent=
                (+$("failed").textContent)+1;

              log(
                "\u2717 Parse "+n+
                " \u2014 "+e.message,
                "err"
              );
            }
          }

          $("done").textContent=
            (+$("done").textContent)+1;

          $("progress").style.width=
            Math.round(
              (+$("done").textContent)/
              Math.max(total,1)*
              100
            )+"%";
        }
      );
    }

    // Flush whatever is left as the final ZIP part.
    await flushIfFull(true);

    if(!$("parts").textContent || $("parts").textContent==="0"){
      log("No CSV files were produced.","err");
    }

  }catch(e){

    log(
      "\u2717 "+e.message,
      "err"
    );

    // Don't lose work already collected if something above throws.
    await flushIfFull(true);

  }finally{

    $("start").disabled=false;
    $("stop").disabled=true;

    $("status").textContent=
      stopped
        ? "Stopped."
        : "Finished.";

    log(
      stopped
        ? "\u25A0 Stopped ("+$("parts").textContent+" ZIP part(s) downloaded so far)."
        : "\uD83C\uDF89 Finished \u2014 "+$("parts").textContent+" ZIP part(s) downloaded.",
      stopped ? "" : "ok"
    );
  }
};

$("stop").onclick=async()=>{
  stopped=true;

  $("status").textContent=
    "Stopping after the current batch\u2026";
};

$("clear").onclick=()=>{
  location.reload();
};
</script>
</body>
</html>`;

function cors(){
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type"
  };
}

function json(data,status=200){
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers:{
        ...cors(),
        "Content-Type":
          "application/json;charset=utf-8"
      }
    }
  );
}

/*
  Fetch sitemap with Worker cache.

  First request:
  Origin site \u2192 Worker \u2192 Cache

  Later request:
  Worker Cache \u2192 fast response
*/
async function fetchSitemap(target){

  const cache=caches.default;

  const cacheKey=new Request(
    new URL(target).toString(),
    {
      method:"GET"
    }
  );

  /*
    Check Worker cache first.
  */
  const cached=await cache.match(cacheKey);

  if(cached){

    return new Response(
      cached.body,
      {
        status:cached.status,
        headers:new Headers(cached.headers)
      }
    );
  }

  /*
    Not cached.
    Fetch from the origin site.
  */
  const upstream=await fetch(
    target,
    {
      method:"GET",
      headers:{
        "User-Agent":"SitemapCSVTool/4.0 (+generic sitemap fetcher)",
        "Accept":"application/xml,text/xml,*/*"
      },
      redirect:"follow"
    }
  );

  if(!upstream.ok)
    return upstream;

  const lenHeader=upstream.headers.get("content-length");
  if(lenHeader && Number(lenHeader)>MAX_UPSTREAM_BYTES){
    return json(
      {error:"Sitemap file too large (>60MB)"},
      413
    );
  }

  /*
    Read once so the same XML can be:
    1. returned
    2. cached
  */
  const body=await upstream.arrayBuffer();

  if(body.byteLength>MAX_UPSTREAM_BYTES){
    return json(
      {error:"Sitemap file too large (>60MB)"},
      413
    );
  }

  const headers=new Headers(
    upstream.headers
  );

  headers.delete("set-cookie");

  headers.set(
    "Cache-Control",
    "public, max-age="+CACHE_TTL
  );

  const responseForCache=new Response(
    body.slice(0),
    {
      status:upstream.status,
      headers
    }
  );

  /*
    Save successful sitemap only.
  */
  try{
    await cache.put(
      cacheKey,
      responseForCache
    );
  }catch{}

  return new Response(
    body,
    {
      status:upstream.status,
      headers
    }
  );
}

export default {

  async fetch(request){

    const url=new URL(request.url);

    if(request.method==="OPTIONS"){
      return new Response(
        null,
        {
          headers:cors()
        }
      );
    }

    /*
      Single sitemap endpoint.
    */
    if(url.pathname==="/api/sitemap"){

      const target=
        url.searchParams.get("url");

      if(!target)
        return json(
          {error:"Missing url parameter"},
          400
        );

      if(!validTarget(target))
        return json(
          {
            error:
              "Only public http(s) URLs are allowed (no local/private addresses)."
          },
          403
        );

      try{

        const upstream=
          await fetchSitemap(target);

        const headers=
          new Headers(upstream.headers);

        for(const [k,v] of Object.entries(cors()))
          headers.set(k,v);

        headers.set(
          "Cache-Control",
          "public, max-age="+CACHE_TTL
        );

        return new Response(
          upstream.body,
          {
            status:upstream.status,
            headers
          }
        );

      }catch(e){

        return json(
          {
            error:"Upstream fetch failed",
            detail:String(e)
          },
          502
        );
      }
    }

    /*
      Streaming batch endpoint.

      Maximum MAX_BATCH sitemap fetches per call.
      Each sitemap is returned immediately when its request finishes.
    */
    if(url.pathname==="/api/batch"){

      if(request.method!=="POST")
        return json(
          {error:"POST required"},
          405
        );

      try{

        const body=await request.json();

        const input=
          Array.isArray(body.urls)
            ? body.urls
            : [];

        /*
          Remove duplicate URLs.
        */
        const urls=[
          ...new Set(input)
        ];

        if(!urls.length)
          return json(
            {error:"No sitemap URLs supplied"},
            400
          );

        if(urls.length>MAX_BATCH)
          return json(
            {
              error:
                "Too many URLs. Maximum per batch is "+
                MAX_BATCH
            },
            400
          );

        if(
          urls.some(
            u=>!validTarget(u)
          )
        )
          return json(
            {
              error:
                "All URLs must be public http(s) addresses (no
