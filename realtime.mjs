import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {poll,relay} from './worker.mjs';

function save(path,value){mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(path+'.tmp',path)}
function supabaseState(url,key,checkpointKey,fetcher=fetch){const endpoint=new URL('/rest/v1/astratrader_meta',url),headers={apikey:key,authorization:'Bearer '+key,'content-type':'application/json'};return{async load(){for(const metaKey of [checkpointKey,'worker:checkpoint']){const u=new URL(endpoint);u.searchParams.set('key','eq.'+metaKey);u.searchParams.set('select','value');const r=await fetcher(u,{headers,signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw Error('Supabase checkpoint read HTTP '+r.status);const rows=await r.json();if(rows[0])return JSON.parse(rows[0].value)}return{}},async save(value){const u=new URL(endpoint);u.searchParams.set('on_conflict','key');const r=await fetcher(u,{method:'POST',headers:{...headers,Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({key:checkpointKey,value:JSON.stringify(value)}),signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw Error('Supabase checkpoint write HTTP '+r.status)}}}

export function websocketUrl(rpcURL,explicit){if(explicit)return explicit;const u=new URL(rpcURL);u.protocol=u.protocol==='https:'?'wss:':'ws:';return u.toString()}
export function subscriptionRequests(programs,commitment='confirmed'){return programs.map((program,index)=>({jsonrpc:'2.0',id:index+1,method:'logsSubscribe',params:[{mentions:[program]},{commitment}]}))}
export function notificationSignature(message){try{const j=typeof message==='string'?JSON.parse(message):message;if(j?.method!=='logsNotification')return null;const value=j?.params?.result?.value;if(!value||value.err||typeof value.signature!=='string')return null;return value.signature}catch{return null}}

function startStream({wsURL,programs,onSignature,enabled=true}){
 let stopped=false,socket=null,retryMs=1000,connected=false,reconnectTimer=null;
 const seen=new Map();
 const remember=sig=>{const now=Date.now();if(seen.has(sig))return false;seen.set(sig,now);if(seen.size>5000){const cutoff=now-30*60*1000;for(const [key,at] of seen){if(at<cutoff||seen.size>4000)seen.delete(key);else break}}return true};
 const schedule=()=>{if(stopped||!enabled)return;clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,retryMs);retryMs=Math.min(30000,retryMs*2)};
 const connect=()=>{if(stopped||!enabled)return;try{socket=new WebSocket(wsURL)}catch(error){console.error(JSON.stringify({at:new Date().toISOString(),event:'stream_connect_failed',error:String(error?.message??error).slice(0,160)}));schedule();return}
  socket.addEventListener('open',()=>{connected=true;retryMs=1000;for(const request of subscriptionRequests(programs,'confirmed'))socket.send(JSON.stringify(request));console.log(JSON.stringify({at:new Date().toISOString(),event:'stream_connected',programs:programs.length,commitment:'confirmed'}))});
  socket.addEventListener('message',event=>{const sig=notificationSignature(String(event.data));if(sig&&remember(sig))onSignature(sig)});
  socket.addEventListener('error',()=>{if(connected)console.error(JSON.stringify({at:new Date().toISOString(),event:'stream_error',message:'WebSocket error; finalized polling remains active'}))});
  socket.addEventListener('close',()=>{const wasConnected=connected;connected=false;if(!stopped){console.error(JSON.stringify({at:new Date().toISOString(),event:'stream_disconnected',wasConnected,message:'Falling back to finalized polling until reconnect'}));schedule()}})
 };
 if(enabled)connect();
 return{stop(){stopped=true;clearTimeout(reconnectTimer);try{socket?.close()}catch{}},get connected(){return connected}};
}

async function main(){
 const e=process.env,url=e.ASTRATRADER_URL,token=e.INGEST_TOKEN,rpcURL=e.SOLANA_RPC_URL,backend=e.PERSISTENCE_BACKEND??(e.SUPABASE_URL?'supabase':'file'),path=e.WORKER_STATE_PATH;
 const usingSupabase=backend==='supabase',sampleSize=Math.max(1,Math.min(100,Number(e.DISCOVERY_SAMPLE_SIZE??50)||50)),pollMs=Math.max(100,Math.min(5000,Number(e.DISCOVERY_POLL_MS??250)||250)),streaming=(e.STREAMING_DISCOVERY_ENABLED??'true')==='true',legacyConfirmedPoll=(e.LEGACY_CONFIRMED_POLLING??'false')==='true';
 const wsURL=websocketUrl(rpcURL,e.SOLANA_WS_URL);
 const missing=[['ASTRATRADER_URL',url],['INGEST_TOKEN',token?.length>=32],['SOLANA_RPC_URL',rpcURL],['PERSISTENCE_BACKEND',['file','supabase'].includes(backend)],['WORKER_STATE_PATH',usingSupabase||path],['SUPABASE_URL',!usingSupabase||e.SUPABASE_URL],['SUPABASE_SERVICE_ROLE_KEY',!usingSupabase||e.SUPABASE_SERVICE_ROLE_KEY?.length>=20],['PERSISTENCE_CONFIRMED',e.PERSISTENCE_CONFIRMED==='true']].filter(x=>!x[1]).map(x=>x[0]);
 if(missing.length)throw Error('Configure realtime worker environment: '+missing.join(', '));if(new URL(url).protocol!=='https:'||new URL(rpcURL).protocol!=='https:'||!['wss:','ws:'].includes(new URL(wsURL).protocol))throw Error('Use HTTPS RPC and WS/WSS streaming endpoints');
 const remote=usingSupabase?supabaseState(e.SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY,'worker:checkpoint:realtime'):null;let state={};if(remote)state=await remote.load();else try{state=JSON.parse(readFileSync(path,'utf8'))}catch(error){if(error.code!=='ENOENT')throw Error('Realtime checkpoint unreadable')}
 const persist=remote?(s=>remote.save(s)):(s=>save(path,s));const programs=(e.DISCOVERY_PROGRAMS??'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4').split(',').map(x=>x.trim()).filter(Boolean);
 let stop=false,cycle=0,streamQueued=0,streamErrors=0,streamChain=Promise.resolve();
 const enqueueStream=signature=>{streamChain=streamChain.then(()=>relay([signature],url,token,fetch,'confirmed')).then(()=>{streamQueued++}).catch(error=>{streamErrors++;console.error(JSON.stringify({at:new Date().toISOString(),event:'stream_relay_failed',error:String(error?.message??error).slice(0,160),message:'Finalized polling will reconcile this signature'}))})};
 const stream=startStream({wsURL,programs,onSignature:enqueueStream,enabled:streaming});
 const shutdown=()=>{stop=true;stream.stop()};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
 const rpc=async(method,params)=>{const r=await fetch(rpcURL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw Error('RPC HTTP '+r.status);const j=await r.json();if(j.error)throw Error('RPC code '+j.error.code);if(!Array.isArray(j.result))throw Error('Unexpected RPC response');return j.result};
 while(!stop){const started=Date.now();try{let chain=Promise.resolve();const persistSerialized=()=>{chain=chain.then(()=>persist(state));return chain};const jobs=[];for(const program of programs){jobs.push(poll(program,state,rpc,(items,c)=>relay(items,url,token,fetch,c),persistSerialized,sampleSize,'finalized','finalized'));if(legacyConfirmedPoll)jobs.push(poll(program,state,rpc,(items,c)=>relay(items,url,token,fetch,c),persistSerialized,sampleSize,'confirmed','confirmed'))}const counts=await Promise.all(jobs);await chain;cycle++;console.log(JSON.stringify({at:new Date().toISOString(),event:'realtime_checkpoint',programs:programs.length,sampleSize,pollMs,streaming,streamConnected:stream.connected,legacyConfirmedPoll,streamQueued,streamErrors,finalizedQueued:counts.reduce((a,b)=>a+b,0),cycle,cycleMs:Date.now()-started}))}catch(error){console.error(JSON.stringify({at:new Date().toISOString(),event:'realtime_failed',error:String(error?.message??error).slice(0,160),message:'Cursors retained; streaming and polling retry independently'}));await sleep(1000)}const remaining=pollMs-(Date.now()-started);if(remaining>0)await sleep(remaining)}
 await streamChain;
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
