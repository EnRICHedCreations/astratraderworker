import {readFileSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {candidateWallets,relay,poll,backfill,backfillWallet,save} from './worker.mjs';

export function shouldRunHistorical({cycle,every,realtimeQueued,sampleSize}){
  return cycle%every===0 && realtimeQueued<sampleSize;
}

function supabaseCheckpoint(url,key,fetcher=fetch){
  const endpoint=new URL('/rest/v1/astratrader_meta',url);
  const headers={apikey:key,authorization:'Bearer '+key,'content-type':'application/json'};
  return {
    async load(){
      const u=new URL(endpoint);u.searchParams.set('key','eq.worker:checkpoint');u.searchParams.set('select','value');
      const r=await fetcher(u,{headers,signal:AbortSignal.timeout(15000),redirect:'error'});
      if(!r.ok)throw Error('Supabase checkpoint read HTTP '+r.status);
      const rows=await r.json();return rows[0]?JSON.parse(rows[0].value):{};
    },
    async save(value){
      const u=new URL(endpoint);u.searchParams.set('on_conflict','key');
      const r=await fetcher(u,{method:'POST',headers:{...headers,Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({key:'worker:checkpoint',value:JSON.stringify(value)}),signal:AbortSignal.timeout(15000),redirect:'error'});
      if(!r.ok)throw Error('Supabase checkpoint write HTTP '+r.status);
    }
  };
}

async function main(){
  const e=process.env,url=e.ASTRATRADER_URL,token=e.INGEST_TOKEN,rpcURL=e.SOLANA_RPC_URL,backend=e.PERSISTENCE_BACKEND??(e.SUPABASE_URL?'supabase':'file'),path=e.WORKER_STATE_PATH;
  const usingSupabase=backend==='supabase';
  const sampleSize=Math.max(1,Math.min(100,Number(e.DISCOVERY_SAMPLE_SIZE??50)||50));
  const pollMs=Math.max(100,Math.min(5000,Number(e.DISCOVERY_POLL_MS??250)||250));
  const fastLane=(e.PAPER_FAST_LANE??'false')==='true';
  const programBackfill=(e.HISTORY_BACKFILL_ENABLED??'false')==='true';
  const programBackfillSize=Math.max(1,Math.min(100,Number(e.HISTORY_BACKFILL_SAMPLE_SIZE??5)||5));
  const programBackfillEvery=Math.max(1,Math.min(1000,Number(e.HISTORY_BACKFILL_EVERY_CYCLES??40)||40));
  const walletBackfill=(e.WALLET_BACKFILL_ENABLED??'true')==='true';
  const walletBackfillSize=Math.max(1,Math.min(25,Number(e.WALLET_BACKFILL_SAMPLE_SIZE??10)||10));
  const walletBackfillEvery=Math.max(8,Math.min(1000,Number(e.WALLET_BACKFILL_EVERY_CYCLES??12)||12));
  const missing=[['ASTRATRADER_URL',url],['INGEST_TOKEN',token?.length>=32],['SOLANA_RPC_URL',rpcURL],['PERSISTENCE_BACKEND',['file','supabase'].includes(backend)],['WORKER_STATE_PATH',usingSupabase||path],['SUPABASE_URL',!usingSupabase||e.SUPABASE_URL],['SUPABASE_SERVICE_ROLE_KEY',!usingSupabase||e.SUPABASE_SERVICE_ROLE_KEY?.length>=20],['PERSISTENCE_CONFIRMED',e.PERSISTENCE_CONFIRMED==='true']].filter(x=>!x[1]).map(x=>x[0]);
  if(missing.length)throw Error('Configure worker environment: '+missing.join(', '));
  if(new URL(url).protocol!=='https:'||new URL(rpcURL).protocol!=='https:')throw Error('Use HTTPS endpoints');
  const remote=usingSupabase?supabaseCheckpoint(e.SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY):null;
  let state={};if(remote)state=await remote.load();else try{state=JSON.parse(readFileSync(path,'utf8'))}catch(error){if(error.code!=='ENOENT')throw Error('Worker checkpoint unreadable')}
  const persist=remote?(s=>remote.save(s)):(s=>save(path,s));
  const programs=(e.DISCOVERY_PROGRAMS??'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4').split(',').map(x=>x.trim()).filter(Boolean);
  let stop=false,cycle=0;process.on('SIGTERM',()=>stop=true);process.on('SIGINT',()=>stop=true);
  const rpc=async(method,params)=>{const r=await fetch(rpcURL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw Error('RPC HTTP '+r.status);const j=await r.json();if(j.error)throw Error('RPC code '+j.error.code);if(!Array.isArray(j.result))throw Error('Unexpected RPC response');return j.result};
  while(!stop){
    const started=Date.now();
    try{
      let persistChain=Promise.resolve();const persistSerialized=()=>{persistChain=persistChain.then(()=>persist(state));return persistChain};
      const realtime=[];
      for(const p of programs){realtime.push(poll(p,state,rpc,(items,c)=>relay(items,url,token,fetch,c),persistSerialized,sampleSize,'finalized','finalized'));if(fastLane)realtime.push(poll(p,state,rpc,(items,c)=>relay(items,url,token,fetch,c),persistSerialized,sampleSize,'confirmed','confirmed'))}
      const realtimeCounts=await Promise.all(realtime);await persistChain;
      const realtimeQueued=realtimeCounts.reduce((a,b)=>a+b,0);let historical=0;
      if(programBackfill&&shouldRunHistorical({cycle,every:programBackfillEvery,realtimeQueued,sampleSize}))for(const p of programs)historical+=await backfill(p,state,rpc,(items,c)=>relay(items,url,token,fetch,c),()=>persist(state),programBackfillSize,'finalized');
      if(walletBackfill&&shouldRunHistorical({cycle,every:walletBackfillEvery,realtimeQueued,sampleSize})){
        const wallets=await candidateWallets(url,token);
        if(wallets.length){const index=Math.floor(cycle/walletBackfillEvery)%wallets.length;historical+=await backfillWallet(wallets[index],state,rpc,(items,c)=>relay(items,url,token,fetch,c),()=>persist(state),walletBackfillSize)}
      }
      cycle++;
      console.log(JSON.stringify({at:new Date().toISOString(),event:'discovery_checkpoint',programs:programs.length,persistence:backend,sampleSize,pollMs,fastLane,realtimeQueued,historicalQueued:historical,programBackfill,walletBackfill,walletBackfillSize,cycleMs:Date.now()-started}));
    }catch(error){console.error(JSON.stringify({at:new Date().toISOString(),event:'discovery_failed',error:String(error?.message??error).slice(0,160),message:'Cursors retained; retrying'}));await sleep(1000)}
    const remaining=pollMs-(Date.now()-started);if(remaining>0)await sleep(remaining);
  }
}

main().catch(e=>{console.error(e.message);process.exitCode=1});
