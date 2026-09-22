// Offline regression through the installed LiteLLM, with a loopback fake provider.
// No real credentials, model calls, or user conversation data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { Readable } from 'node:stream';
import { zaiCacheUsageTransform } from '../src/zai-cache-usage.mjs';
import { grokReasoningSummaryCompatTransform } from '../src/grok-reasoning-summary-compat.mjs';
import { ZaiResponsesCompatTransform } from '../src/zai-responses-compat.mjs';
import { translatedToolMessageCompatTransform } from '../src/deepseek-tool-message-compat.mjs';
import { ItemLifecycleNormalizer } from '../src/item-lifecycle-normalizer.mjs';
import { bridgeCustomTools, NamespaceToolCallTransform } from '../src/namespace-relay.mjs';

const python = process.argv[2];
assert.ok(python, 'usage: node scripts/verify-deepseek-litellm-compat.mjs <venv-python>');
const reasoning = 'PRIVATE_TEST_REASONING';
const answer = '我来核对。';
const received = [];
const patch = '*** Begin Patch\n*** End Patch';
const bridgedMode = process.argv.includes('--bridged');
const namespaces = new Map();
const nativeTools = [{ type: 'custom', name: 'apply_patch' }];
const requestTools = bridgedMode ? bridgeCustomTools(nativeTools, [], namespaces).tools : nativeTools;
async function collect(stream) {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}
const server = http.createServer(async (request, response) => {
  const body = JSON.parse(await collect(request));
  received.push(body);
  const mode = body.model;
  const chunks = [];
  if (!mode.includes('reasoning-first')) chunks.push({ role: 'assistant', content: '' });
  chunks.push({ reasoning_content: reasoning });
  if (!mode.includes('tool-only')) chunks.push({ content: answer });
  if (mode.includes('tool')) chunks.push({ tool_calls: [{ index: 0, id: 'call_test', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ [bridgedMode ? 'input' : 'content']: patch }) } }] });
  chunks.push({});
  const raw = chunks.map((delta, index) => {
    const last = index === chunks.length - 1;
    return `data: ${JSON.stringify({
      id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1788910000, model: mode,
      choices: [{ index: 0, delta, finish_reason: last ? (mode.includes('tool') ? 'tool_calls' : 'stop') : null }],
      ...(last ? { usage: { prompt_tokens: 1234, completion_tokens: 20, total_tokens: 1254, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 234 } } : {}),
    })}\n\n`;
  }).join('') + 'data: [DONE]\n\n';
  const normalized = await collect(Readable.from([raw]).pipe(zaiCacheUsageTransform('deepseek', 'text/event-stream')));
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(normalized);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const code = String.raw`
import asyncio,json,sys,litellm
async def main():
 for mode in ['role-first','reasoning-first','role-first-tool','reasoning-first-tool','role-first-tool-only','reasoning-first-tool-only']:
  stream=await litellm.aresponses(model='openai/'+mode, input=[{'role':'user','content':'first'}, {'role':'assistant','content':[{'type':'thinking','text':'prior reasoning'},{'type':'output_text','text':'prior answer'}]}, {'role':'user','content':'test'}],tools=json.loads(sys.argv[2]),stream=True,api_base='http://127.0.0.1:'+sys.argv[1]+'/v1',api_key='local-dummy',use_chat_completions_api=True)
  events=[]
  async for event in stream: events.append(event.model_dump())
  print(json.dumps({'mode':mode,'events':events}),flush=True)
asyncio.run(main())
`;
try {
  const child = spawn(python, ['-c', code, String(server.address().port), JSON.stringify(requestTools)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const exit = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(exit, 0, await stderr);
  for (const line of (await stdout).trim().split('\n')) {
    const { mode, events: raw } = JSON.parse(line);
    const input = raw.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    let stream = Readable.from([input])
      .pipe(translatedToolMessageCompatTransform({ id: 'deepseek' }, 'text/event-stream'))
      .pipe(grokReasoningSummaryCompatTransform('deepseek', 'text/event-stream'))
      .pipe(new ZaiResponsesCompatTransform({ repairItemIndexes: true }))
      .pipe(new NamespaceToolCallTransform(namespaces, 'text/event-stream'))
      .pipe(new ItemLifecycleNormalizer());
    const text = await collect(stream);
    const events = text.trim().split('\n\n').map(frame => JSON.parse(frame.split('\n').find(l => l.startsWith('data:')).slice(5)));
    const completed = events.find(event => event.type === 'response.completed');
    assert.equal(completed.response.usage.input_tokens, 1234, mode + ' lost authoritative input usage');
    assert.equal(completed.response.usage.output_tokens, 20, mode + ' lost output usage');
    const messages = events.filter(e => e.type === 'response.output_item.done' && e.item?.type === 'message');
    const visible = messages.flatMap(e => e.item.content).map(p => p.text || '').join('');
    assert.equal(visible, mode.includes('tool-only') ? '' : answer, mode + ' duplicated or leaked visible text');
    assert.ok(!events.filter(e => e.type === 'response.content_part.done').some(e => JSON.stringify(e).includes(reasoning)), mode + ' leaked reasoning into message close');
    const reasons = events.filter(e => e.type === 'response.output_item.done' && e.item?.type === 'reasoning');
    assert.equal(reasons.flatMap(e => e.item.summary || []).map(p => p.text).join(''), reasoning, mode + ' lost reasoning');
    const tools = events.filter(e => e.type === 'response.output_item.done' && e.item?.type === 'custom_tool_call');
    assert.equal(tools.length, mode.includes('tool') ? 1 : 0, mode + ' changed tool execution count');
    if (tools.length) {
      assert.equal(tools[0].item.input, patch, mode + ' changed patch text');
      assert.equal(completed.response.output.find(item => item.type === 'custom_tool_call')?.input, patch);
      assert.equal(events.filter(event => event.type === 'response.custom_tool_call_input.done').length, 1);
    }
    const ids = new Set();
    const indexes = new Set();
    for (const event of events.filter(e => e.type === 'response.output_item.added')) {
      assert.ok(!ids.has(event.item.id), mode + ' reused item ID'); ids.add(event.item.id);
      assert.ok(!indexes.has(event.output_index), mode + ' reused output index'); indexes.add(event.output_index);
    }
    console.log(mode + ': reasoning separate; answer once; tools preserved; input=1234');
  }
  assert.equal(received.length, 6);
  const carried = received[0].messages.find(message => message.role === 'assistant');
  assert.ok(carried.content.some(part => part.type === 'thinking' && part.text === 'prior reasoning'), 'LiteLLM lost the separate reasoning replay');
  assert.ok(!carried.content.some(part => part.type === 'text' && part.text.includes('prior reasoning')), 'LiteLLM merged reasoning into visible history');
} finally { await new Promise(resolve => server.close(resolve)); }
