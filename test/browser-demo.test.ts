import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { createLab } from '../public/demo/engine-entry.js';
test('browser SQLite journal performs bidirectional delivery and suppresses duplicate/echo events',async t=>{
  const lab=await createLab(await initSqlJs());t.after(()=>lab.close());
  let state=await lab.step('root');assert.equal(state.links.length,1);assert.equal(state.receipts.length,2);
  state=await lab.step('duplicate');assert.equal(state.result.duplicate,true);assert.equal(state.receipts.length,2);
  state=await lab.step('reply');assert.equal(state.receipts.length,3);assert.equal(state.receipts[0].kind,'slack.post');
  state=await lab.step('slack-reply');assert.equal(state.receipts[0].kind,'ticket.comment');
  const count=state.receipts.length;state=await lab.step('echo');assert.equal(state.events[0].status,'ignored');assert.equal(state.receipts.length,count);
  state=await lab.step('status');assert.equal(state.links[0].status,'Done');
});
test('lost receipt stays uncertain across journal reconstruction and reconciliation adds no second write',async t=>{
  const lab=await createLab(await initSqlJs());t.after(()=>lab.close());await lab.step('root');
  let state=await lab.step('lost');assert.equal(state.events[0].status,'held');assert.equal(state.effects[0].status,'uncertain');
  const count=state.receipts.length;state=await lab.step('restart');assert.equal(state.effects[0].status,'uncertain');
  state=await lab.step('reconcile');assert.equal(state.events[0].status,'succeeded');assert.equal(state.receipts.length,count);assert.equal(state.effects.filter(e=>e.status==='uncertain').length,0);
});
