// 无硬件联调用的模拟器页面：电脑麦克风当 INMP441，电脑喇叭当 MAX98357A。
// 和真机走同一个 /robot/api/turn，只是把「上传音频」换成浏览器录音。

export function simPage(token) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 小机器人 · 模拟器</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:24px;max-width:760px;margin:0 auto;background:#0f1116;color:#e6e8ee}
h1{font-size:18px;margin:0 0 4px}p.h{color:#8b93a7;margin:0 0 20px}
.card{border:1px solid #262b38;border-radius:12px;padding:16px;margin-bottom:14px;background:#151922}
button{font:inherit;padding:8px 14px;border-radius:9px;border:1px solid #303748;background:#1d2331;color:#e6e8ee;cursor:pointer}
button:hover{background:#242b3b}button.rec{background:#7a1f2b;border-color:#a33043}
input,textarea{font:inherit;width:100%;box-sizing:border-box;padding:8px 10px;border-radius:9px;border:1px solid #303748;background:#0f1116;color:#e6e8ee}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.badge{font-size:12px;color:#8b93a7}
pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0;color:#9aa4bb;font-size:12px}
</style></head><body>
<h1>ESP32 小机器人 · 模拟器</h1>
<p class="h">没有硬件也能把整条链路跑一遍：电脑麦克风当 INMP441，电脑喇叭当 MAX98357A。地址就是真机要用的地址。</p>
<div class="card">
  <div class="row"><button id="rec" class="rec">按住说话</button><span class="badge" id="recState">空闲</span>
  <button id="stop" style="display:none">结束并发送</button></div>
  <p class="badge">录音是 16kHz 单声道，和固件上传的格式一样。</p>
</div>
<div class="card">
  <div class="row"><input id="text" placeholder="也可以直接打字，测试大脑和语音"><button id="send">发送</button></div>
</div>
<div class="card">
  <div class="row"><span class="badge">最近一轮</span></div>
  <pre id="out">（还没有）</pre>
</div>
<script>
const TOKEN=${JSON.stringify(token)};
const $=(id)=>document.getElementById(id);
function show(o){$('out').textContent=typeof o==='string'?o:JSON.stringify(o,null,2)}
async function playPcm(buf, rate){
  const ctx=new AudioContext();
  const i16=new Int16Array(buf.buffer,buf.byteOffset,Math.floor(buf.byteLength/2));
  const f32=new Float32Array(i16.length);
  for(let i=0;i<i16.length;i++) f32[i]=i16[i]/32768;
  const b=ctx.createBuffer(1,f32.length,rate||16000);
  b.copyToChannel(f32,0);
  const s=ctx.createBufferSource();s.buffer=b;s.connect(ctx.destination);s.start();
  await new Promise(r=>{s.onended=r;setTimeout(r,(b.duration+0.2)*1000)});
  ctx.close();
}
async function send(body, headers){
  const r=await fetch('/robot/api/turn',{method:'POST',headers:{'x-robot-token':TOKEN,...(headers||{})},body});
  const ct=r.headers.get('content-type')||'';
  if(ct.includes('json')){const j=await r.json();show(j);return j}
  const ab=await r.arrayBuffer();
  const u8=new Uint8Array(ab);
  let nl=-1;for(let i=0;i<Math.min(u8.length,8192);i++){if(u8[i]===10){nl=i;break}}
  const head=JSON.parse(new TextDecoder().decode(u8.slice(0,nl)));
  show(head);
  await playPcm(u8.slice(nl+1),head.rate||16000);
  return head;
}
$('send').onclick=async()=>{
  const t=$('text').value.trim();if(!t)return;
  $('out').textContent='思考中…';
  try{await send(JSON.stringify({text:t,id:'sim'}),{'content-type':'application/json'})}catch(e){show('出错：'+e.message)}
};
let ac=null,proc=null,chunks=[];
$('rec').onclick=async()=>{
  if(ac)return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
    ac=new AudioContext({sampleRate:16000});
    const src=ac.createMediaStreamSource(stream);
    proc=ac.createScriptProcessor(4096,1,1);chunks=[];
    proc.onaudioprocess=(e)=>{const d=e.inputBuffer.getChannelData(0);const c=new Float32Array(d.length);c.set(d);chunks.push(c)};
    src.connect(proc);proc.connect(ac.destination);
    $('rec').textContent='录音中…';$('recState').textContent='说话';$('stop').style.display='inline-block';
  }catch(e){show('打不开麦克风：'+e.message)}
};
$('stop').onclick=async()=>{
  if(!ac)return;
  const total=chunks.reduce((n,c)=>n+c.length,0);
  const all=new Float32Array(total);let o=0;for(const c of chunks){all.set(c,o);o+=c.length}
  try{proc.disconnect()}catch(e){}
  try{await ac.close()}catch(e){}
  ac=null;proc=null;chunks=[];
  $('rec').textContent='按住说话';$('recState').textContent='空闲';$('stop').style.display='none';
  if(total<1600){show('太短了，再说长一点');return}
  const pcm=new Int16Array(total);for(let i=0;i<total;i++){const v=Math.max(-1,Math.min(1,all[i]));pcm[i]=v<0?v*32768:v*32767}
  $('out').textContent='识别 + 思考中…';
  try{await send(new Uint8Array(pcm.buffer),{'content-type':'application/octet-stream'})}catch(e){show('出错：'+e.message)}
};
</script></body></html>`
  }
