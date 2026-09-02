import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_IDS = new Set((process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(x=>x.trim()).filter(Boolean));
const DB = path.resolve(process.env.MONSTARX_DB || './licenses.json');

function load(){ try{return JSON.parse(fs.readFileSync(DB,'utf8'));}catch{return {users:{}};} }
function save(db){ fs.writeFileSync(DB, JSON.stringify(db,null,2)); }
function durationMs(v){ const m=String(v).match(/^(\\d+)(m|h|d)$/i); if(!m) return null; const n=Number(m[1]); return n*({m:60000,h:3600000,d:86400000}[m[2].toLowerCase()]); }
function grant(userId,duration){ const ms=durationMs(duration); if(!ms) return null; const db=load(); const now=Date.now(); db.users[String(userId)]={userId:String(userId),active:true,owner:false,grantedAt:new Date(now).toISOString(),expiresAt:new Date(now+ms).toISOString()}; save(db); return db.users[String(userId)]; }
function revoke(userId){ const db=load(); if(db.users[String(userId)]) db.users[String(userId)].active=false; save(db); return db.users[String(userId)]||null; }
function getAccess(userId){ const db=load(); const x=db.users[String(userId)]; if(!x) return {active:false,owner:false,expiresAt:null}; if(!x.owner && x.expiresAt && Date.now()>=Date.parse(x.expiresAt)){x.active=false; save(db);} return x; }

app.get('/api/access/:userId',(req,res)=>res.json(getAccess(req.params.userId)));
app.get('/health',(req,res)=>res.json({ok:true}));

async function tg(method, body){
  if(!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return r.json();
}

async function handleUpdate(update){
  const msg=update.message; if(!msg?.text) return;
  const from=String(msg.from.id); if(ADMIN_IDS.size && !ADMIN_IDS.has(from)) return;
  const parts=msg.text.trim().split(/\\s+/); const cmd=parts[0].split('@')[0];
  if(cmd==='/grant' && parts.length===3){ const x=grant(parts[1],parts[2]); return tg('sendMessage',{chat_id:msg.chat.id,text:x?`Granted ${parts[2]} access to ${parts[1]}.\\nExpires: ${x.expiresAt}`:'Usage: /grant USER_ID 15m|1h|1d'}); }
  if(cmd==='/revoke' && parts.length===2){ revoke(parts[1]); return tg('sendMessage',{chat_id:msg.chat.id,text:`Revoked access for ${parts[1]}.`}); }
  if(cmd==='/check' && parts.length===2){ const x=getAccess(parts[1]); return tg('sendMessage',{chat_id:msg.chat.id,text:JSON.stringify(x,null,2)}); }
  return tg('sendMessage',{chat_id:msg.chat.id,text:'Commands:\n/grant USER_ID 15m|1h|1d\n/revoke USER_ID\n/check USER_ID'});
}

let offset=0;
async function poll(){
  if(!BOT_TOKEN) return setTimeout(poll,5000);
  try{ const r=await tg('getUpdates',{offset,timeout:25}); if(r.ok){ for(const u of r.result){offset=u.update_id+1; await handleUpdate(u);} } }catch(e){console.error(e.message);} setImmediate(poll);
}
poll();

app.listen(PORT,()=>console.log(`MONSTARX access server listening on :${PORT}`));


# // Added access durations: 7d, 1mo, 1y
ACCESS_DURATIONS = {"7d": 7*24*60*60, "1mo": 30*24*60*60, "1y": 365*24*60*60}
