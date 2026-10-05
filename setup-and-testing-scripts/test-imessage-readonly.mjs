import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isImessageSafeReadArgs, isNotesSafeReadArgs, runUniversalCli } from '../fastify-app/universal-cli.mjs';
const valid = [
 ['chats','--limit','2','--json'],
 ['history','--chat-id','21','--limit','5','--json'],
 ['history','--chat-id','21','--limit','5','--start','2026-01-01T00:00:00Z','--end','2026-02-01T00:00:00Z'],
 ['search','--query',"Trader Joe's",'--limit','3','--match','contains','--json'],
];
const invalid = [
 ['history','--chat-id','1'], ['history','--chat-id','0','--limit','3'], ['chats','--limit','999'],
 ['search','--query','x','--limit','3','--db','/tmp/chat.db'],
 ['history','--chat-id','1','--limit','3','--convert-attachments'],
 ['search','--query','x','--limit','3','--limit','20'], ['read','--chat-id','1'],
 ['send','--to','+15551234567','--text','test'], ['search','--query','--help','--limit','3'],
 ['history','--chat-id','1','--limit','3','--start','2026-02-01T00:00:00Z','--end','2026-01-01T00:00:00Z'],
];
test('iMessage bounded reads reject mutations, alternate databases, conversion and ambiguous options', () => {
 for (const args of valid) assert.equal(isImessageSafeReadArgs(args),true,JSON.stringify(args));
 for (const args of invalid) assert.equal(isImessageSafeReadArgs(args),false,JSON.stringify(args));
 assert.equal(isNotesSafeReadArgs(['search','x','-l','3','--limit','20']),false);
 assert.equal(isNotesSafeReadArgs(['search','x','-f','A','--folder','B']),false);
});
test('Mac aliases execute literal reads without confirmation and never execute rejected writes', async () => {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'phoneclaw-imsg-'))), saved={...process.env};
 try {
  const executable=join(root,'imsg'), config=join(root,'config.json');
  writeFileSync(executable,`#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`,{mode:0o700});
  writeFileSync(config,JSON.stringify(Object.fromEntries(['imsg','mac-imsg'].map(name=>[name,{executable,env:[],blockedArgs:[['send'],['read']]}]))));
  process.env.GENERIC_CLI_ALLOWED_DIRS=root;process.env.GENERIC_CLI_PROGRAMS_PATH=config;
  for (const command of ['imsg','mac-imsg']) {
   for(const args of valid) {const r=await runUniversalCli({command,args,cwd:root});assert.equal(r.ok,true);assert.deepEqual(JSON.parse(r.stdout),args);}
   for(const args of invalid) {const r=await runUniversalCli({command,args,cwd:root});assert.equal(r.ok,false);assert.equal(r.stdout,'');}
   assert.equal((await runUniversalCli({command,args:['read','--chat-id','1'],cwd:root,confirmed:true})).status,'command_blocked');
  }
 } finally {for(const k of Object.keys(process.env)) delete process.env[k];Object.assign(process.env,saved);rmSync(root,{recursive:true,force:true});}
});
