'use strict';
const CFG={durSec:15,sr:44100,maxSide:2048,thumb:200,histMax:20,mp3:'http://127.0.0.1:7777'};
const EMO={'温暖':['氛围电子',[70,100],'maj',45,1],'治愈':['氛围电子',[65,95],'maj',35,1],'科技':['电子',[100,125],'min',60,0],'轻快':['流行',[110,135],'maj',75,0],'活力':['流行',[115,140],'maj',85,0],'紧张':['电子',[100,130],'min',70,0],'悲伤':['钢琴叙事',[55,80],'min',25,-1],'大气':['管弦',[80,105],'maj',65,0],'恢弘':['管弦',[85,110],'maj',80,0],'神秘':['氛围电子',[70,95],'min',40,0],'俏皮':['流行',[115,140],'maj',80,1],'深沉':['钢琴叙事',[60,85],'min',35,-1],'热血':['摇滚',[125,150],'maj',90,1],'激昂':['摇滚',[120,150],'maj',90,0],'宁静':['氛围电子',[55,80],'maj',25,1],'浪漫':['钢琴叙事',[70,95],'maj',45,1],'忧郁':['钢琴叙事',[58,82],'min',30,-1],'兴奋':['电子',[120,145],'maj',85,0],'空灵':['氛围电子',[60,85],'min',30,0],'复古':['复古电子',[95,120],'min',55,0]};
const SCENE={'产品发布':[['轻鼓'],5],'宣传片':[['弦乐Pad'],0],'活动':[['轻鼓'],8],'旅行':[['拨弦'],5],'vlog':[['拨弦'],8],'纪录':[['钢琴'],-5],'游戏':[['合成贝斯'],12],'派对':[['轻鼓'],15]};
const TEMPO=[['缓慢',[55,85]],['舒缓',[55,85]],['中速',[85,110]],['轻快',[110,130]],['激烈',[130,160]],['卡点',[130,160]],['慢',[55,85]],['快',[130,160]]];
const BANR=[['人声',['人声','歌声','哼唱','唱'],'noLead'],['鼓',['鼓','打击'],'noDrum'],['贝斯',['贝斯','低音'],'noBass'],['钢琴',['钢琴'],'noPiano'],['弦乐',['弦乐'],'noPad'],['吵闹',['吵','嘈杂','闹'],'noiseCap']];
const STYLE_EN={'氛围电子':'ambient electronic','电子':'electronic','流行':'pop','钢琴叙事':'emotional piano','管弦':'orchestral','摇滚':'rock','复古电子':'retro synthwave'};
const INST_EN={'钢琴':'piano','合成Pad':'warm synth pad','弦乐Pad':'string pad','拨弦':'plucked strings','合成贝斯':'synth bass','贝斯':'bass','轻鼓':'soft drums','鼓':'drums'};
const MOOD_EN={'温暖':'warm','治愈':'healing','科技':'techy','轻快':'light-hearted','活力':'energetic','紧张':'tense','悲伤':'sad','大气':'grand','恢弘':'epic','神秘':'mysterious','俏皮':'playful','深沉':'deep','热血':'passionate','激昂':'uplifting','宁静':'serene','浪漫':'romantic','忧郁':'melancholic','兴奋':'excited','空灵':'ethereal','复古':'nostalgic'};
const BAN_EN={'人声':'vocals, singing','鼓':'drums and percussion','贝斯':'bass','钢琴':'piano','弦乐':'strings','吵闹':'loud noisy mix'};
const TONIC=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const TAGS=[['温暖治愈','温暖治愈，适合产品发布片开头，不要人声'],['科技感','科技感，紧张而克制，不要鼓'],['轻快活力','轻快活力，适合 vlog 片头，不要太吵'],['大气恢弘','大气恢弘，宣传片氛围，不要人声'],['宁静安详','宁静安详，纪录片质感，不要鼓'],['神秘空灵','神秘空灵，适合游戏画面'],['浪漫深情','浪漫深情，适合婚礼宣传，不要贝斯'],['热血激昂','热血激昂，活动开场，不要人声'],['忧郁深沉','忧郁深沉，雨天画面，不要太吵'],['复古怀旧','复古，派对氛围，不要钢琴'],['兴奋卡点','兴奋，节奏快一点，不要弦乐'],['空灵安静','空灵，安静一点，不要鼓']];
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hashStr=s=>{let h=5381;for(let i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))>>>0;return h>>>0;};
const mulberry32=a=>function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
const m2f=m=>440*Math.pow(2,(m-69)/12);
const noteMidi=n=>{const m=/^([A-G]#?)(\d)$/.exec(n);return(+m[2]+1)*12+TONIC.indexOf(m[1]);};
let tt=null;const toast=m=>{const t=$('toast');t.textContent=m;t.classList.add('show');clearTimeout(tt);tt=setTimeout(()=>t.classList.remove('show'),3200);};
const fmtTime=ms=>{const d=new Date(ms),p=x=>String(x).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());};
const fmtSec=s=>String(Math.floor(s/60)).padStart(2,'0')+':'+String(Math.floor(s%60)).padStart(2,'0');
const hueName=(h,s)=>s<0.12||h<0?'中性':h<15||h>=345?'红':h<40?'橙':h<70?'黄':h<160?'绿':h<200?'青':h<260?'蓝':h<320?'紫':'粉红';
const hueTonic=h=>TONIC[Math.floor(clamp(h<0?0:h,0,359)/30)];
const inferEmo=f=>f.brightness<0.32?'忧郁':f.brightness>0.65&&f.saturation>0.4?'活力':f.hue>=0&&f.hue<70&&f.brightness>0.5?'温暖':f.hue>=180&&f.hue<270?'空灵':'宁静';
async function parseImageFile(file){
  if(!/^image\/(jpeg|png|webp)$/.test(file.type)){
    if(/hei[cf]/i.test(file.type+' '+file.name))throw{code:'HEIC'};throw{code:'FORMAT'};
  }
  let bmp;try{bmp=await createImageBitmap(file);}catch(e){throw{code:'DECODE'};}
  try{
    const sc=Math.min(1,CFG.maxSide/Math.max(bmp.width,bmp.height));
    const w=Math.max(1,Math.round(bmp.width*sc)),h=Math.max(1,Math.round(bmp.height*sc));
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;
    const cx=cv.getContext('2d',{willReadFrequently:true});cx.drawImage(bmp,0,0,w,h);
    if(bmp.close)bmp.close();
    const d=cx.getImageData(0,0,w,h).data,n=w*h,lum=new Float32Array(n);
    let bs=0,ss=0,chr=0,oR=0,oG=0,oB=0;
    const hc=new Array(12).fill(0),hr=Array.from({length:12},()=>[0,0,0,0]);
    for(let i=0,p=0;i<n;i++,p+=4){
      const r=d[p],g=d[p+1],b=d[p+2];oR+=r;oG+=g;oB+=b;
      const mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/510;lum[i]=l;bs+=l;
      const st=mx===0?0:(mx-mn)/mx;ss+=st;
      if(st>0.15&&mx>40){
        const dd=mx-mn;
        let hu=dd===0?0:mx===r?60*(((g-b)/dd)%6):mx===g?60*(((b-r)/dd)+2):60*(((r-g)/dd)+4);
        if(hu<0)hu+=360;
        const bi=Math.min(11,Math.floor(hu/30));hc[bi]++;chr++;hr[bi][0]+=r;hr[bi][1]+=g;hr[bi][2]+=b;hr[bi][3]++;
      }
    }
    const brightness=bs/n,saturation=ss/n;
    const mainColors=hc.map((c,i)=>({c,i})).sort((a,b)=>b.c-a.c).slice(0,5).filter(x=>x.c>0).map(x=>{
      const a=hr[x.i],r=Math.round(a[0]/a[3]),g=Math.round(a[1]/a[3]),b=Math.round(a[2]/a[3]);
      return{hex:'#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase(),hue:x.i*30+15,count:x.c};
    });
    if(!mainColors.length){
      const r=Math.round(oR/n),g=Math.round(oG/n),b=Math.round(oB/n);
      mainColors.push({hex:'#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase(),hue:-1,count:n});
    }
    const hue=chr>0?hc.indexOf(Math.max(...hc))*30+15:-1;
    const st=Math.max(1,Math.floor(Math.min(w,h)/64));let cells=0,edges=0;
    for(let y=0;y+st<h;y+=st)for(let x=0;x+st<w;x+=st){const i=y*w+x;cells++;if(Math.abs(lum[i]-lum[i+st])+Math.abs(lum[i]-lum[i+w*st])>0.09)edges++;}
    const density=cells?edges/cells:0;
    const x0=w*0.2|0,x1=Math.ceil(w*0.8),y0=h*0.2|0,y1=Math.ceil(h*0.8);
    let c1=0,c2=0,cn=0,e1=0,e2=0,en=0;
    for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){const v=lum[y*w+x];if(x>=x0&&x<x1&&y>=y0&&y<y1){cn++;c1+=v;c2+=v*v;}else{en++;e1+=v;e2+=v*v;}}
    const vo=(s1,s2,k)=>k?Math.max(0,s2/k-(s1/k)*(s1/k)):0;
    const subjectStrength=clamp(Math.round(50+(Math.sqrt(vo(c1,c2,cn))-Math.sqrt(vo(e1,e2,en)))*400),0,100);
    const moodSentence='画面以'+hueName(hue,saturation)+'为主，整体'+(brightness>0.6?'明亮':brightness<0.4?'偏暗':'明暗适中')+'，饱和度'+(saturation>0.5?'较高':saturation<0.22?'较低':'中等')+'，'+(density>0.3?'细节密集':density<0.12?'画面简洁':'细节适中')+'，'+(subjectStrength>60?'主体突出':subjectStrength<35?'无明显主体':'主体适中')+'。';
    const ts=Math.min(1,CFG.thumb/Math.max(w,h)),tw=Math.max(1,Math.round(w*ts)),th=Math.max(1,Math.round(h*ts));
    const tc=document.createElement('canvas');tc.width=tw;tc.height=th;tc.getContext('2d').drawImage(cv,0,0,tw,th);
    const thumbBlob=await new Promise(r=>tc.toBlob(r,'image/jpeg',0.8));
    return{mainColors,brightness,saturation,density,subjectStrength,hue,moodSentence,thumbBlob};
  }catch(err){throw err&&err.code?err:{code:'DECODE'};}
}
function parsePrompt(text){
  const t=(text||'').replace(/\s+/g,' ');
  const emotions=[];
  for(const k in EMO){if(t.includes(k)&&!emotions.includes(k))emotions.push(k);if(emotions.length>=3)break;}
  let scene=null;for(const k in SCENE)if(t.includes(k)){scene=k;break;}
  let tempo=null;for(const[k,r]of TEMPO)if(t.includes(k)){tempo=r;break;}
  const bans=[];
  for(const[name,kws]of BANR)for(const kw of kws){
    if(new RegExp('(不要|别|避免|不用|不想)[要有太过于更得加很]{0,3}'+kw).test(t)){if(!bans.includes(name))bans.push(name);break;}
  }
  const unknown=[],dw=Object.keys(EMO).concat(Object.keys(SCENE),TEMPO.map(x=>x[0]),BANR.flatMap(r=>r[1]));
  for(const s0 of t.split(/[\s，。,.、；;！!？?"'（）()[\]【】]+/).filter(Boolean)){
    const s=s0.replace(/(的|地|得|里|感|气息)/g,'');
    if(s.length<2)continue;
    if(!dw.some(k=>s.includes(k))&&!unknown.includes(s0)&&unknown.length<6)unknown.push(s0);
  }
  return{emotions,scene,tempo,bans,unknown};
}
const baseInst=s=>s==='电子'||s==='摇滚'||s==='复古电子'?['合成Pad','合成贝斯','轻鼓']:s==='流行'?['钢琴','拨弦','贝斯','轻鼓']:s==='钢琴叙事'?['钢琴','弦乐Pad']:s==='管弦'?['弦乐Pad','拨弦','轻鼓']:['合成Pad','钢琴'];
function synthPlan(f,p){
  const conflicts=[],src={emotion:p.emotions.length?'prompt':'image',tempo:p.tempo?'prompt':'none',scene:p.scene?'prompt':'none',bans:p.bans.length?'prompt':'none'};
  const ek=p.emotions.length?p.emotions[0]:inferEmo(f),e=EMO[ek];
  let style=e[0],mode=e[2],energy=e[3],bpm=Math.round((e[1][0]+e[1][1])/2);
  if(p.tempo)bpm=clamp(Math.round((p.tempo[0]+p.tempo[1])/2),e[1][0]-8,e[1][1]+8);
  let inst=baseInst(style).slice();
  if(p.scene){for(const x of SCENE[p.scene][0])if(!inst.includes(x))inst.push(x);bpm+=SCENE[p.scene][1];}
  if(f.density>0.35&&!inst.includes('轻鼓'))inst.push('轻鼓');
  if(f.density<0.12)inst=inst.filter(i=>i!=='轻鼓');
  if(f.subjectStrength<30)energy=Math.min(energy,35);
  const flag={};for(const b of p.bans){const r=BANR.find(x=>x[0]===b);if(r)flag[r[2]]=true;}
  if(flag.noiseCap){energy=Math.min(energy,40);bpm=Math.min(bpm,100);}
  if(flag.noDrum)inst=inst.filter(i=>i!=='轻鼓'&&i!=='鼓');
  if(flag.noBass)inst=inst.filter(i=>i!=='贝斯'&&i!=='合成贝斯');
  if(flag.noPiano)inst=inst.filter(i=>i!=='钢琴');
  if(flag.noPad)inst=inst.filter(i=>i!=='合成Pad'&&i!=='弦乐Pad');
  if(!inst.length)inst=['拨弦'];
  const cold=(f.hue>=180&&f.hue<270)||f.brightness<0.32;
  if(e[4]===1&&cold)conflicts.push('提示词「'+ek+'」（暖）× 画面冷色调，已按提示词执行');
  if(e[4]===-1&&f.hue>=0&&f.hue<70&&f.saturation>0.3)conflicts.push('提示词「'+ek+'」（冷）× 画面暖色调，已按提示词执行');
  const tonic=hueTonic(f.hue),key=tonic+(mode==='maj'?' 大调':' 小调');
  const ambient=f.subjectStrength<30||energy<35;
  const sections=ambient?[[0,4,'铺底'],[4,7,'起伏'],[11,4,'收束']]:[[0,3,'渐入'],[3,9,'主题'],[12,3,'渐出']];
  const curve=energy>=70?'高开缓落':energy<=35?'缓慢铺开':'中段推高';
  return{style,bpm:clamp(Math.round(bpm),40,180),key,tonic,mode,instruments:inst,sections,curve,conflicts,sources:src,energy,ambient,noLead:!!flag.noLead,noDrum:!!flag.noDrum,noBass:!!flag.noBass,noPiano:!!flag.noPiano,noPad:!!flag.noPad,emo:ek};
}
function diffPlans(a,b){
  const dims=[a.style!==b.style,a.bpm!==b.bpm,a.key!==b.key,a.instruments.join('|')!==b.instruments.join('|'),a.curve!==b.curve,JSON.stringify(a.sections)!==JSON.stringify(b.sections)];
  const changed=dims.filter(Boolean).length,bpmDiff=Math.abs(a.bpm-b.bpm),keySwitch=a.tonic!==b.tonic||a.mode!==b.mode;
  return{changed,bpmDiff,keySwitch,pass:changed>=3&&(bpmDiff>=8||keySwitch)};
}
function buildPromptPair(plan,parsed){
  const ce=plan.curve==='高开缓落'?'energetic opening with a soft landing':plan.curve==='中段推高'?'building to a mid-section peak':'slowly unfolding';
  const positive=[STYLE_EN[plan.style]||plan.style,plan.bpm+' BPM',plan.tonic+(plan.mode==='maj'?' major':' minor'),plan.instruments.map(i=>INST_EN[i]||i).join(' + '),ce,(MOOD_EN[plan.emo]||plan.emo)+' mood','15 seconds background music'].join(', ');
  const neg=((parsed&&parsed.bans)||[]).map(b=>BAN_EN[b]||b);if(plan.noLead)neg.push('vocals');
  const u=Array.from(new Set(neg));
  return{positive,negative:'Avoid: '+(u.length?u.join(', '):'none')};
}
function composeMusic(plan,seed){
  const rng=mulberry32((seed>>>0)||1),beat=60/plan.bpm;
  const prog=plan.mode==='maj'?[0,7,9,5]:[0,8,3,10],th=plan.mode==='maj'?4:3;
  const base=noteMidi(plan.tonic+'4'),pent=plan.mode==='maj'?[0,2,4,7,9,12]:[0,3,5,7,10,12];
  const ev=[];let bar=0;
  for(const[s0,len,lab]of plan.sections){
    const end=s0+len,gk=lab==='渐入'||lab==='铺底'?0.55:lab==='渐出'||lab==='收束'?0.7:1;
    const drum=lab==='主题'||lab==='起伏'||lab==='渐出';
    for(let t=s0;t<end-0.001;t+=beat*2,bar++){
      const root=base-12+prog[bar%4],tri=[root,root+th,root+7];
      if(!plan.noPad)ev.push({type:'pad',t,dur:Math.min(beat*2,end-t),gain:.1*gk,notes:tri.map(m=>({m:m+12}))});
      if(!plan.noBass)ev.push({type:'bass',t,dur:Math.min(beat*1.8,end-t),gain:.22*gk,notes:[{m:root-12}]});
      if(!plan.noDrum&&drum){
        if(t+0.2<end)ev.push({type:'kick',t,dur:.18,gain:.26*gk});
        if(plan.energy>70&&t+beat+0.2<end)ev.push({type:'kick',t:t+beat,dur:.16,gain:.2*gk});
        if(plan.energy>45){
          if(t+beat*0.55<end)ev.push({type:'hat',t:t+beat*0.5,dur:.05,gain:.055*gk});
          if(t+beat*1.55<end)ev.push({type:'hat',t:t+beat*1.5,dur:.05,gain:.05*gk});
        }
      }
      if(!plan.noPiano){
        const st=lab==='渐入'||lab==='铺底'?2:4;
        for(let si=0;si<st;si++){
          const pt=t+si*(beat*2/st);if(pt+0.15>=end)break;
          ev.push({type:'piano',t:pt,dur:Math.min(beat*2/st*0.9,end-pt),gain:.16*gk,notes:[{m:tri[si%3]+(si>=3?12:0)}]});
        }
      }
      if(plan.instruments.includes('拨弦')&&rng()<0.6){
        const pt=t+beat*(0.5+rng()*1.2);
        if(pt+0.4<end)ev.push({type:'pluck',t:pt,dur:.35,gain:.09*gk,notes:[{m:base+12+pent[rng()*5|0]}]});
      }
      if(!plan.noLead&&(lab==='主题'||lab==='起伏')){
        let lt=t+rng()*beat*0.5;
        while(lt+beat*0.5<end){
          const dc=[beat*0.5,beat,beat*1.5][rng()*3|0];
          ev.push({type:'lead',t:lt,dur:Math.min(dc*0.85,end-lt),gain:.11*gk,notes:[{m:base+12+pent[rng()*pent.length|0]}]});
          lt+=dc;
        }
      }
    }
  }
  return ev.sort((a,b)=>a.t-b.t);
}
async function renderBuffer(events){
  const ctx=new OfflineAudioContext(1,CFG.durSec*CFG.sr,CFG.sr);
  const nb=ctx.createBuffer(1,0.2*CFG.sr|0,CFG.sr),nd=nb.getChannelData(0);
  for(let i=0;i<nd.length;i++)nd[i]=Math.random()*2-1;
  const ma=ctx.createGain();ma.gain.value=.9;ma.connect(ctx.destination);
  for(const e of events){
    if(e.type==='hat'){
      const s=ctx.createBufferSource();s.buffer=nb;
      const f=ctx.createBiquadFilter();f.type='highpass';f.frequency.value=6000;
      const g=ctx.createGain();g.gain.setValueAtTime(e.gain,e.t);g.gain.exponentialRampToValueAtTime(.001,e.t+e.dur);
      s.connect(f);f.connect(g);g.connect(ma);s.start(e.t);s.stop(e.t+e.dur);
    }else if(e.type==='kick'){
      const o=ctx.createOscillator();o.type='sine';
      o.frequency.setValueAtTime(150,e.t);o.frequency.exponentialRampToValueAtTime(40,e.t+.12);
      const g=ctx.createGain();g.gain.setValueAtTime(e.gain,e.t);g.gain.exponentialRampToValueAtTime(.001,e.t+e.dur);
      o.connect(g);g.connect(ma);o.start(e.t);o.stop(e.t+e.dur+.02);
    }else for(const nt of e.notes){
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type=e.type==='pad'?'sawtooth':e.type==='piano'?'sine':e.type==='lead'?'sawtooth':'triangle';
      o.frequency.value=m2f(nt.m);
      if(e.type==='pad'){
        g.gain.setValueAtTime(.0001,e.t);
        g.gain.linearRampToValueAtTime(e.gain,e.t+Math.min(.5,e.dur*.3));
        g.gain.setValueAtTime(e.gain,e.t+e.dur*.8);
        g.gain.linearRampToValueAtTime(.0001,e.t+e.dur);
      }else{
        const at=e.type==='piano'?.02:.008;
        g.gain.setValueAtTime(.0001,e.t);
        g.gain.linearRampToValueAtTime(e.gain,e.t+at);
        g.gain.exponentialRampToValueAtTime(.0008,e.t+Math.max(at+.02,e.dur));
      }
      let node=o;
      if(e.type==='pad'||e.type==='lead'){const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=e.type==='pad'?1200:2500;o.connect(lp);node=lp;}
      node.connect(g);g.connect(ma);o.start(e.t);o.stop(e.t+e.dur+.05);
    }
  }
  const buf=await ctx.startRendering(),ch=buf.getChannelData(0);
  let pk=0;for(let i=0;i<ch.length;i++)pk=Math.max(pk,Math.abs(ch[i]));
  if(pk>0)for(let i=0;i<ch.length;i++)ch[i]*=.92/pk;
  return buf;
}
function encodeWav(buf){
  const ch=buf.getChannelData(0),n=ch.length,ab=new ArrayBuffer(44+n*2),v=new DataView(ab);
  const w=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  w(0,'RIFF');v.setUint32(4,36+n*2,true);w(8,'WAVE');w(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,buf.sampleRate,true);v.setUint32(28,buf.sampleRate*2,true);
  v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,n*2,true);
  for(let i=0;i<n;i++){const s=Math.max(-1,Math.min(1,ch[i]));v.setInt16(44+i*2,s<0?s*0x8000:s*0x7FFF,true);}
  return ab;
}
const peaks=(buf,k)=>{const ch=buf.getChannelData(0),per=ch.length/k|0,o=[];for(let i=0;i<k;i++){let m=0;for(let j=0;j<per;j+=16)m=Math.max(m,Math.abs(ch[i*per+j]));o.push(m);}return o;};
function drawWave(p){
  const cv=$('wave'),cx=cv.getContext('2d'),w=cv.width,h=cv.height,bw=w/p.length;
  cx.clearRect(0,0,w,h);cx.fillStyle='#3b6cff';
  p.forEach((v,i)=>{const bh=Math.max(2,v*h*.9);cx.fillRect(i*bw+.5,(h-bh)/2,Math.max(1,bw-1.5),bh);});
}
const idb=()=>new Promise((res,rej)=>{const r=indexedDB.open('yzc_hist',1);r.onupgradeneeded=()=>{r.result.createObjectStore('rec',{keyPath:'id'});r.result.createObjectStore('selftest',{keyPath:'id'});};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
async function dbRun(store,mode,fn){const db=await idb();return new Promise((res,rej)=>{const tx=db.transaction(store,mode),q=fn(tx.objectStore(store));tx.oncomplete=()=>res(q&&q.result!==undefined?q.result:undefined);tx.onerror=()=>rej(tx.error);});}
async function trimStore(st){const all=await dbRun(st,'readonly',s=>s.getAll());if(all.length>CFG.histMax){all.sort((a,b)=>a.time-b.time);for(let i=0;i<all.length-CFG.histMax;i++)await dbRun(st,'readwrite',s=>s.delete(all[i].id));}}
const saveHistory=async r=>{await dbRun('rec','readwrite',s=>s.put(r));await trimStore('rec');};
async function probe(){try{const c=new AbortController(),tm=setTimeout(()=>c.abort(),1500),r=await fetch(CFG.mp3+'/ping',{signal:c.signal});clearTimeout(tm);return await r.json();}catch(e){return null;}}
async function mp3Encode(w){const r=await fetch(CFG.mp3+'/mp3',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:w});if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer();}
const S={f:null,plan:null,parsed:null,seed:0,wav:null,pk:null,state:'empty',exp:[]};
const setBtn=()=>{const s=S.state;
  $('btnGen').disabled=!(S.f&&s!=='parsing');$('btnGen').textContent=s==='parsing'?'生成中…':'开始生成';
  $('btnRetry').disabled=s!=='generated';$('btnAdjust').disabled=!(S.f&&s!=='parsing');
  $('btnMp3').disabled=$('btnWav').disabled=s!=='generated';
};
async function handleFile(file){
  if(S.state==='parsing')return;
  S.state='parsing';setBtn();$('dzText').innerHTML='正在解析画面…';
  try{
    const f=await parseImageFile(file);S.f=f;S.state='ready';
    $('dzText').innerHTML='已就绪，点击可替换图片<br><span class="hint">'+esc(file.name)+'</span>';
    showFeat(f);preview();toast('画面解析完成，可输入提示词并生成');
  }catch(err){
    S.f=null;S.state='error';
    $('dzText').innerHTML='图片解析失败，请换一张图片<br><span class="hint">'+(err&&err.code==='HEIC'?'HEIC 暂不支持，请转 JPG/PNG':'支持 JPG / PNG / WebP')+'</span>';
    toast(err&&err.code==='HEIC'?'HEIC 格式暂不支持':'图片解析失败，请换一张图片');
  }
  setBtn();
}
function showFeat(f){
  $('featCard').hidden=false;
  const bar=(n,v)=>'<div class="bar-row"><span>'+n+'</span><div class="bar"><i style="width:'+Math.round(v*100)+'%"></i></div><b>'+Math.round(v*100)+'</b></div>';
  $('featPanel').innerHTML='<div class="feat-colors">'+f.mainColors.map(c=>'<span class="swatch" style="background:'+c.hex+'" title="'+c.hex+'"></span>').join('')+'</div>'
    +bar('亮度',f.brightness)+bar('饱和度',f.saturation)+bar('密度',f.density)+bar('主体强度',f.subjectStrength/100)
    +'<div class="feat-sentence">'+esc(f.moodSentence)+'</div>';
  if(f.thumbBlob){$('dzThumb').src=URL.createObjectURL(f.thumbBlob);$('dzThumb').hidden=false;}
}
function planCard(p){
  if(!p){$('planCard').innerHTML='<div class="plan-empty">上传图片并输入提示词后，这里展示方案（风格 · BPM · 调式 · 编制 · 情绪曲线）</div>';return;}
  const src=['情绪：'+(p.sources.emotion==='prompt'?'提示词':'画面推断')];
  if(p.sources.tempo==='prompt')src.push('节奏：提示词');
  if(p.sources.scene==='prompt')src.push('场景：提示词');
  if(p.sources.bans==='prompt')src.push('禁用：提示词');
  $('planCard').innerHTML='<div class="plan-head"><span class="plan-style">'+esc(p.style)+'</span>'+(p.ambient?'<span class="badge">铺底型</span>':'')+'<span class="badge badge-e">能量 '+p.energy+'</span></div>'
    +'<div class="plan-row"><b>'+p.bpm+'</b> BPM · <b>'+esc(p.key)+'</b> · 情绪：'+esc(p.emo)+'</div>'
    +'<div class="plan-sec">'+p.instruments.map(i=>'<span class="chip">'+esc(i)+'</span>').join('')+'</div>'
    +'<div class="plan-sec">'+p.sections.map(s=>'<span class="chip">'+esc(s[2])+' '+s[0]+'–'+(s[0]+s[1])+'s</span>').join('')+'</div>'
    +'<div class="plan-sec">情绪曲线：'+esc(p.curve)+'</div>'
    +'<div class="plan-sec">'+src.map(s=>'<span class="src-chip">'+esc(s)+'</span>').join('')+'</div>'
    +(p.conflicts.length?'<div class="conflict-box">'+p.conflicts.map(c=>'⚠ '+esc(c)).join('<br>')+'</div>':'');
}
function enPrompt(p,pd){
  if(!p){$('enCard').hidden=true;return;}
  const pp=buildPromptPair(p,pd||{bans:[]});
  $('enCard').hidden=false;$('enPos').textContent=pp.positive;$('enNeg').textContent=pp.negative;
}
function preview(){if(!S.f)return;const pd=parsePrompt($('promptInput').value),p=synthPlan(S.f,pd);planCard(p);enPrompt(p,pd);}
async function renderAudio(seed){
  const ev=composeMusic(S.plan,seed),buf=await renderBuffer(ev);
  S.wav=encodeWav(buf);S.pk=peaks(buf,140);
  setAudio(URL.createObjectURL(new Blob([S.wav],{type:'audio/wav'})));
  drawWave(S.pk);$('playerBar').hidden=false;
}
async function saveRec(text){
  const f=S.f;
  await saveHistory({id:'r'+Date.now()+Math.floor(Math.random()*1e4),time:Date.now(),prompt:text,
    features:{mainColors:f.mainColors,brightness:f.brightness,saturation:f.saturation,density:f.density,subjectStrength:f.subjectStrength,hue:f.hue,moodSentence:f.moodSentence},
    plan:JSON.parse(JSON.stringify(S.plan)),wav:new Blob([S.wav],{type:'audio/wav'}),thumb:f.thumbBlob||null,peaks:S.pk});
  histUI();
}
async function generate(){
  if(!S.f||S.state==='parsing')return;
  S.state='parsing';setBtn();
  try{
    const text=$('promptInput').value;
    S.parsed=parsePrompt(text);S.plan=synthPlan(S.f,S.parsed);
    S.seed=hashStr(text+'|'+Math.round(S.f.hue*10));
    await renderAudio(S.seed);
    S.state='generated';planCard(S.plan);enPrompt(S.plan,S.parsed);
    await saveRec(text);toast('已生成 15 秒音频，可试听与下载');
  }catch(e){toast('生成失败：'+(e.message||'未知错误'));S.state=S.wav?'generated':'ready';}
  setBtn();
}
async function retry(){
  if(S.state!=='generated'||!S.plan)return;
  S.state='parsing';setBtn();
  S.seed=(S.seed*1664525+1013904223)>>>0;
  await renderAudio(S.seed);S.state='generated';
  await saveRec($('promptInput').value);setBtn();
  toast('已重掷细节层种子：方案不变，细节变化');
}
async function restore(r){
  try{
    const f=Object.assign({},r.features);f.thumbBlob=r.thumb;
    S.f=f;$('promptInput').value=r.prompt||'';S.parsed=parsePrompt(r.prompt||'');S.plan=r.plan;
    S.wav=await r.wav.arrayBuffer();S.pk=r.peaks||new Array(140).fill(.5);
    setAudio(URL.createObjectURL(r.wav));drawWave(S.pk);showFeat(f);
    planCard(S.plan);enPrompt(S.plan,S.parsed);
    $('playerBar').hidden=false;S.state='generated';setBtn();tab('main');
    toast('已恢复历史记录');
  }catch(e){toast('历史恢复失败：'+(e.message||'数据损坏'));}
}
async function histUI(){
  let all=[];try{all=await dbRun('rec','readonly',s=>s.getAll());}catch(e){}
  all.sort((a,b)=>b.time-a.time);
  const box=$('histList');box.innerHTML='';
  if(!all.length){box.innerHTML='<div class="hist-empty">暂无历史记录（本机保存最近 20 条，不上传）</div>';return;}
  for(const r of all){
    const d=document.createElement('div');d.className='hist-item';
    d.innerHTML=(r.thumb?'<img src="'+URL.createObjectURL(r.thumb)+'" alt="">':'')
      +'<div class="hist-info"><div class="hist-prompt">'+esc(r.prompt||'（无提示词）')+'</div><div class="hist-time">'+fmtTime(r.time)+(r.plan?' · '+esc(r.plan.style)+' · '+r.plan.bpm+' BPM · '+esc(r.plan.key):'')+'</div></div><button class="btn">恢复</button>';
    d.querySelector('button').onclick=()=>restore(r);
    box.appendChild(d);
  }
}
function dl(ab,mime,name){const u=URL.createObjectURL(new Blob([ab],{type:mime})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),4000);}
const fname=x=>'mood_'+(MOOD_EN[S.plan.emo]||'mood').replace(/[^a-zA-Z]/g,'')+'_'+S.plan.bpm+'_15s.'+x;
async function dlMp3(){
  if(!S.wav||!S.plan)return;
  const p=await probe();
  if(!p||!p.ffmpeg){dl(S.wav,'audio/wav',fname('wav'));toast('MP3 服务未启动，已降级下载 WAV。启动：node serve.mjs（需本机 ffmpeg），地址 127.0.0.1:7777');return;}
  try{dl(await mp3Encode(S.wav),'audio/mpeg',fname('mp3'));toast('MP3 已下载（128k）');}
  catch(e){dl(S.wav,'audio/wav',fname('wav'));toast('MP3 转码失败，已降级下载 WAV：'+(e.message||''));}
}
function setAudio(u){const a=$('player');if(a.src&&a.src.indexOf('blob:')===0){try{URL.revokeObjectURL(a.src);}catch(e){}}a.src=u;a.load();$('curTime').textContent='00:00';}
async function copyText(t){try{await navigator.clipboard.writeText(t);return true;}catch(e){const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();let ok=false;try{ok=document.execCommand('copy');}catch(_){}ta.remove();return ok;}}
const FIX={hue:210,brightness:.45,saturation:.35,density:.3,subjectStrength:55};
const TESTS=[
['B-01','色调→主音映射确定性',()=>{if(hueTonic(0)!=='C'||hueTonic(210)!=='A'||hueTonic(359)!=='B')throw'映射不符';return'hue 0→C、210→A、359→B，纯查表';}],
['B-02','WAV 头 44 字节规范',()=>{const ab=encodeWav({sampleRate:44100,getChannelData:()=>new Float32Array([0,.5,-.5,1,.25])}),v=new DataView(ab);if(String.fromCharCode(v.getUint8(0),v.getUint8(1),v.getUint8(2),v.getUint8(3))!=='RIFF')throw'RIFF 错误';if(v.getUint32(40,true)!==10||ab.byteLength!==54)throw'长度错误';return'RIFF/WAVE 头与 data 长度正确';}],
['B-03','伪随机种子可复现',()=>{const r1=mulberry32(12345),r2=mulberry32(12345);for(let i=0;i<8;i++)if(r1()!==r2())throw'序列不一致';return'同种子两次序列完全一致';}],
['B-04','合成时长恒 15 秒',()=>{const p=synthPlan(FIX,{emotions:['温暖'],scene:null,tempo:null,bans:[],unknown:[]}),ev=composeMusic(p,7);let m=0;for(const e of ev)m=Math.max(m,e.t+e.dur);if(m>15.01)throw'越界 '+m;return'事件最晚 '+m.toFixed(2)+'s ≤ 15s';}],
['S-01','方案合成纯函数确定性',()=>{const a=synthPlan(FIX,{emotions:['科技'],scene:'产品发布',tempo:[110,130],bans:['人声'],unknown:[]}),b=synthPlan(FIX,{emotions:['科技'],scene:'产品发布',tempo:[110,130],bans:['人声'],unknown:[]});if(JSON.stringify(a)!==JSON.stringify(b))throw'输出不一致';if(a.sources.tempo!=='prompt')throw'来源标记错';return'同输入两次输出逐字节一致';}],
['S-02','禁用项解析',()=>{const p=parsePrompt('温暖治愈，适合产品发布片开头，不要人声，不要太吵');if(!p.bans.includes('人声')||!p.bans.includes('吵闹'))throw'禁用项不全';if(p.scene!=='产品发布')throw'场景错';return'识别【'+p.bans.join('、')+'】+ 场景【产品发布】';}],
['S-03','未识别词显性收集',()=>{const p=parsePrompt('雨天里的霓虹闪烁');if(!p.unknown.length)throw'未收集';return'未识别词：'+p.unknown.join('、');}],
['S-04','提示词优先与冲突记录',()=>{const p=synthPlan({hue:220,brightness:.3,saturation:.3,density:.2,subjectStrength:50},{emotions:['温暖'],scene:null,tempo:null,bans:[],unknown:[]});if(p.mode!=='maj')throw'调式未按提示词';if(!p.conflicts.length)throw'未记冲突';return'冷画面×温暖词：大调 + 冲突入框';}],
['S-05','低主体强度→铺底结构',()=>{const p=synthPlan({hue:30,brightness:.5,saturation:.4,density:.1,subjectStrength:18},{emotions:['宁静'],scene:null,tempo:null,bans:[],unknown:[]});if(!p.ambient||p.sections[0][2]!=='铺底')throw'结构错误';return'铺底 4s+起伏 7s+收束 4s';}],
['S-06','禁用"吵"→节奏能量封顶',()=>{const p=synthPlan(FIX,{emotions:['活力'],scene:null,tempo:[130,160],bans:['吵闹'],unknown:[]});if(p.bpm>100||p.energy>40)throw'未封顶';return'BPM→'+p.bpm+'，能量→'+p.energy;}],
['S-07','判据边界（冻结）',()=>{const mk=o=>Object.assign({style:'流行',bpm:100,key:'C 大调',tonic:'C',mode:'maj',instruments:['钢琴','贝斯'],curve:'中段推高',sections:[[0,3,'渐入']]},o);const A=diffPlans(mk({}),mk({style:'电子',bpm:107,instruments:['钢琴','鼓']})),B=diffPlans(mk({}),mk({style:'电子',bpm:108,instruments:['钢琴','鼓']})),C=diffPlans(mk({}),mk({style:'电子',bpm:120}));if(A.pass!==false||B.pass!==true||C.pass!==false)throw'边界误判';return'3×BPM7=否；3×BPM8=是；2×BPM20=否';}],
['S-08','历史 20 条淘汰实测',async()=>{for(let i=0;i<21;i++){await dbRun('selftest','readwrite',s=>s.put({id:'t'+i,time:1000+i}));await trimStore('selftest');}const all=await dbRun('selftest','readonly',s=>s.getAll()),n=all.length;for(const r of all)await dbRun('selftest','readwrite',s=>s.delete(r.id));if(n!==20)throw'保留 '+n+' 条';return'写 21 实测保留 20（最旧淘汰），测试库已清理';}]
];
async function runTests(){
  const tb=$('testBody');tb.innerHTML='';let pass=0;
  for(const[id,name,fn]of TESTS){
    let st='通过',note='';
    try{note=await fn();}catch(e){st='不通过';note=e.message||String(e);}
    if(st==='通过')pass++;
    tb.insertAdjacentHTML('beforeend','<tr><td>'+id+'</td><td>'+esc(name)+'</td><td class="'+(st==='通过'?'ok':'bad')+'">'+st+'</td><td>'+esc(note)+'</td></tr>');
  }
  $('testSummary').textContent='自检结果：'+pass+'/'+TESTS.length+' 通过';
}
async function runBatch(){
  const files=Array.from($('expFiles').files||[]),words=$('expWords').value.split('\n').map(s=>s.trim()).filter(Boolean);
  if(!files.length||!words.length){toast('请选择图片并输入提示词清单（每行一个）');return;}
  if(files.length>24||words.length>8){toast('为控制耗时：图片 ≤24 张、提示词 ≤8 条');return;}
  $('expRun').disabled=true;$('expProg').textContent='实验运行中…';
  const rows=[];let done=0;
  for(const f of files){
    let ft;try{ft=await parseImageFile(f);}catch(e){rows.push({img:f.name,err:e.code||'DECODE'});continue;}
    let base=null;
    for(const w of words){
      const p=synthPlan(ft,parsePrompt(w));
      rows.push({img:f.name,w,p,d:base?diffPlans(base,p):null});
      if(!base)base=p;done++;$('expProg').textContent='已完成 '+done+' 组';
    }
  }
  S.exp=rows;expUI(rows);$('expRun').disabled=false;$('expProg').textContent='完成 '+done+' 组，可导出 CSV';
}
function expUI(rows){
  const tb=$('expBody');tb.innerHTML='';
  for(const r of rows){
    if(!r.p){tb.insertAdjacentHTML('beforeend','<tr><td>'+esc(r.img)+'</td><td colspan="8" class="bad">解析失败（'+esc(r.err)+'）</td></tr>');continue;}
    const d=r.d;
    tb.insertAdjacentHTML('beforeend','<tr><td>'+esc(r.img)+'</td><td>'+esc(r.w)+'</td><td>'+esc(r.p.style)+'</td><td>'+r.p.bpm+'</td><td>'+esc(r.p.key)+'</td><td>'+(d?d.changed:'基线')+'</td><td>'+(d?d.bpmDiff:'—')+'</td><td>'+(d?(d.keySwitch?'是':'否'):'—')+'</td><td class="'+(d?(d.pass?'ok':'bad'):'')+'">'+(d?(d.pass?'显著':'不显著'):'基线')+'</td></tr>');
  }
}
function expCsv(){
  const rows=S.exp;
  if(!rows.length){toast('请先运行批量实验');return;}
  const q=x=>'"'+String(x).replace(/"/g,'""')+'"';
  const L=[['图','词','风格','BPM','调式','编制','曲线','结构','变化项数','BPM差','调式切换','判定'].map(q).join(',')];
  for(const r of rows){
    if(!r.p){L.push([r.img,r.w,'','','','','','','','','','解析失败:'+r.err].map(q).join(','));continue;}
    const p=r.p,d=r.d;
    L.push([r.img,r.w,p.style,p.bpm,p.key,p.instruments.join('+'),p.curve,p.sections.map(s=>s[2]+s[0]+'s').join('/'),d?d.changed:'基线',d?d.bpmDiff:'',d?(d.keySwitch?'是':'否'):'',d?(d.pass?'显著':'不显著'):'基线'].map(q).join(','));
  }
  dl(new TextEncoder().encode('\uFEFF'+L.join('\n')),'text/csv','experiment_diff.csv');
  toast('CSV 已导出');
}
function tab(id){
  document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+id));
  if(id==='history')histUI();
}
(function(){
  TAGS.forEach(t=>{const s=document.createElement('span');s.className='tag';s.textContent=t[0];s.title=t[1];s.onclick=()=>{$('promptInput').value=t[1];preview();};$('tagRow').appendChild(s);});
  setBtn();histUI();runTests();
  probe().then(p=>{$('mp3State').textContent=p?(p.ffmpeg?'MP3 服务已就绪（127.0.0.1:7777 · ffmpeg 可用）':'服务已启动但未检测到 ffmpeg，请按 serve.mjs 指引安装'):'MP3 服务未启动：下载 MP3 将降级为 WAV（启动：node serve.mjs）';});
  document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>tab(b.dataset.tab));
  $('dropzone').onclick=()=>$('dzInput').click();
  $('dzInput').onchange=e=>{const f=e.target.files[0];if(f)handleFile(f);e.target.value='';};
  $('dropzone').addEventListener('dragover',e=>{e.preventDefault();$('dropzone').classList.add('drag');});
  $('dropzone').addEventListener('dragleave',()=>$('dropzone').classList.remove('drag'));
  $('dropzone').addEventListener('drop',e=>{e.preventDefault();$('dropzone').classList.remove('drag');const f=e.dataTransfer.files[0];if(f)handleFile(f);});
  let deb=null;
  $('promptInput').addEventListener('input',()=>{clearTimeout(deb);deb=setTimeout(preview,250);});
  $('btnGen').onclick=()=>generate();
  $('btnRetry').onclick=()=>retry();
  $('btnAdjust').onclick=()=>{toast('已按当前提示词重新合成方案与音频');generate();};
  $('btnWav').onclick=()=>{if(S.wav)dl(S.wav,'audio/wav',fname('wav'));};
  $('btnMp3').onclick=()=>dlMp3();
  $('btnCopy').onclick=async()=>{toast(await copyText($('enPos').textContent+'\n'+$('enNeg').textContent)?'英文提示词已复制':'复制失败，请手动选择复制');};
  $('player').addEventListener('timeupdate',()=>{$('curTime').textContent=fmtSec($('player').currentTime);});
  $('wave').onclick=e=>{const a=$('player');if(!a.src)return;const r=e.currentTarget.getBoundingClientRect();a.currentTime=clamp((e.clientX-r.left)/r.width*CFG.durSec,0,CFG.durSec);};
  $('btnTest').onclick=()=>runTests();
  $('expRun').onclick=()=>runBatch();
  $('expCsv').onclick=()=>expCsv();
})();
