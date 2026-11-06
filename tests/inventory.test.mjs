import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitInventory, releaseInventory } from '../src/services/inventory.service.ts';
const env={MS2_URL:'https://catalog.invalid',MS2_INTERNAL_KEY:'fixture-key'};
test('una reserva no se confirma ni libera por un HTTP 200 vacío o fallido',async t=>{
  let result=null;
  t.mock.method(globalThis,'fetch',async()=>Response.json(result));
  for(const body of [null,{}, {success:false}, {success:true,data:{state:'RESERVED'}}]) {
    result=body;
    await assert.rejects(commitInventory('fixture',env));
    await assert.rejects(releaseInventory('fixture',env));
  }
  result={success:true,data:{state:'COMMITTED'}};
  await commitInventory('fixture',env);
  result={success:true,data:{state:'RELEASED'}};
  await releaseInventory('fixture',env);
});
