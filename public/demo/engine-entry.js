import initSqlJs from 'sql.js';
import { Journal } from '../../src/journal.ts';
import { MockAdapter } from '../../src/adapters.ts';
import { slackEvent, jiraEvent, toAdf } from '../../src/events.ts';
export const config={mode:'mock',team:'T_DEMO',channel:'C_SUPPORT',project:'OPS',issueType:'Task',doneTransition:'31',serviceActor:'bridge-service'};
export async function createLab(SQL) {
  SQL ||= await initSqlJs({locateFile:()=>new URL('./sql-wasm.wasm',import.meta.url).href});
  const sqlite=new SQL.Database();
  const db={
    all(query,...params){const stmt=sqlite.prepare(query);try{stmt.bind(params);const rows=[];while(stmt.step())rows.push(stmt.getAsObject());return rows;}finally{stmt.free();}},
    run(query,...params){if(params.length)sqlite.run(query,params);else sqlite.exec(query);},
    transaction(fn){sqlite.run('BEGIN');try{const result=fn();sqlite.run('COMMIT');return result;}catch(error){sqlite.run('ROLLBACK');throw error;}},
  };
  let journal=new Journal(db,config),mock=new MockAdapter(db,config),lastWire=null,lastResult=null,counter=0;
  const thread='1780740000.000001';
  const rootWire={type:'event_callback',team_id:config.team,event_id:'demo-root',event:{type:'message',channel:config.channel,user:'U_REQUESTER',ts:thread,text:'The weekly report export fails when I select a date range. Can someone take a look?'}};
  const snapshot=()=>({...journal.snapshot(),receipts:mock.receipts(),wire:lastWire,result:lastResult});
  async function apply(provider,wire,id) {
    const event=provider==='slack'?slackEvent(wire,config):jiraEvent(wire,config,id);
    lastWire={provider,payload:wire,delivery_id:id};lastResult=await journal.accept(event);await journal.pump(mock);return snapshot();
  }
  return {
    snapshot,
    async step(action,value=''){
      const link=journal.snapshot().links[0];
      if(action==='root')return apply('slack',structuredClone(rootWire));
      if(action==='duplicate'){if(!lastWire)throw Error('Send an event first.');return apply(lastWire.provider,lastWire.payload,lastWire.delivery_id);}
      if(!link)throw Error('Create the first request to link a thread and ticket.');
      if(action==='reply'||action==='lost'){
        if(action==='lost')mock.fail('timeout_after_write');
        return apply('jira',{webhookEvent:'comment_created',timestamp:1780740001000+ ++counter,issue:{key:link.issue,fields:{updated:'2026-06-06T10:00:01Z'}},comment:{id:'comment-'+counter,updated:new Date(1780740001000+counter).toISOString(),author:{accountId:'engineer-demo'},body:toAdf(value||'I reproduced the issue. A fix is ready for review.')}},'jira-comment-'+counter);
      }
      if(action==='slack-reply')return apply('slack',{type:'event_callback',team_id:config.team,event_id:'slack-reply-'+ ++counter,event:{type:'message',channel:config.channel,user:'U_REQUESTER',ts:`178074000${counter}.000001`,thread_ts:link.thread,text:value||'Thanks. I can test the fix this afternoon.'}});
      if(action==='echo')return apply('slack',{type:'event_callback',team_id:config.team,event_id:'demo-echo-'+ ++counter,event:{type:'message',channel:config.channel,bot_id:'B_BRIDGE',user:'U_BOT',ts:'1780740099.000001',thread_ts:link.thread,text:'Mirrored reply',metadata:{event_type:'threadbridge',event_payload:{origin_event:'jira-comment-1'}}}});
      if(action==='status')return apply('jira',{webhookEvent:'jira:issue_updated',timestamp:1780740200000,issue:{key:link.issue,fields:{updated:'2026-06-06T10:03:20Z',status:{name:'Done'}}},user:{accountId:'engineer-demo'},changelog:{items:[{field:'status',fromString:'Open',toString:'Done'}]}},'jira-done');
      if(action==='reconcile'){
        const effect=journal.snapshot().effects.find(e=>e.status==='uncertain');if(!effect)throw Error('No uncertain delivery needs reconciliation.');
        const receipt=mock.receipts().find(r=>r.key===effect.payload.eventId+':'+effect.kind);if(!receipt)throw Error('No matching simulated provider receipt.');
        journal.reconcile(effect.key,receipt.receipt);await journal.pump(mock);lastResult={reconciled:true,key:effect.key};return snapshot();
      }
      if(action==='restart'){journal=new Journal(db,config);mock=new MockAdapter(db,config);lastResult={restarted:true};return snapshot();}
      throw Error('Unknown demo action');
    },
    close(){sqlite.close();},
  };
}
