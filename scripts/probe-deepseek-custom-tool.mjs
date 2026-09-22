import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { callerBaseUrl } from '../src/caller-auth.mjs';
import assert from 'node:assert/strict';
const fixture = new URL('../generated/deepseek-tool-probe.txt', import.meta.url).pathname;
const receipt = new URL('../generated/deepseek-probe-response.json', import.meta.url);
const followup = process.argv.includes('--readback');
const initial = { role: 'user', content: `Call apply_patch once to add ${fixture} containing probe-ok. This is a tool transport test.` };
let input = [initial];
if (followup) {
  const previous = JSON.parse(await readFile(receipt, 'utf8'));
  const call = previous.output.find(item => item.type === 'custom_tool_call');
  const content = await readFile(fixture, 'utf8');
  assert.equal(content.trim(), 'probe-ok');
  input = [initial, ...previous.output, { type: 'custom_tool_call_output', call_id: call.call_id,
    output: JSON.stringify({ written: true, verified_content: content }) },
    { role: 'user', content: 'The tool executed and its file was read back. Reply only VERIFIED if the tool result confirms probe-ok; do not call more tools.' }];
}
const secret = (await readFile(new URL('../../../../.codex/codex-router/caller-secret', import.meta.url), 'utf8')).trim();
const response = await fetch(`${callerBaseUrl(4202, secret)}/responses`, {
  method: 'POST',
  headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-expires-on-0910', stream: true,
    input,
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch. Input is freeform patch text, not JSON. Use *** Begin Patch, *** Add File: path, +line, *** End Patch.' }],
    max_output_tokens: 1000 }),
  signal: AbortSignal.timeout(45000),
});
console.log('HTTP', response.status);
assert.equal(response.status, 200);
try {
  const text = await response.text();
  let completed = false;
  for (const frame of text.split('\n\n')) {
    const line = frame.split('\n').find(line => line.startsWith('data:'));
    if (!line || line.slice(5).trim() === '[DONE]') continue;
    const event = JSON.parse(line.slice(5));
    if (event.type === 'response.completed') {
      completed = true;
      assert.equal(event.response.status, 'completed');
      if (!followup) {
        const calls = event.response.output.filter(item => item.type === 'custom_tool_call');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'apply_patch');
        assert.ok(calls[0].input.includes(fixture));
        await mkdir(new URL('../generated/', import.meta.url), { recursive: true });
        await writeFile(receipt, JSON.stringify(event.response));
        console.log(JSON.stringify({ call: calls[0], usage: event.response.usage }));
      } else {
        const answer = event.response.output.filter(item => item.type === 'message')
          .flatMap(item => item.content || []).map(part => part.text || '').join('');
        assert.match(answer, /VERIFIED/);
        console.log(JSON.stringify({ readback: 'verified', answer, usage: event.response.usage }));
      }
    }
    if (event.type === 'response.failed') throw new Error('Provider response failed');
  }
  assert.ok(completed, 'Stream ended without response.completed');
} catch (error) { console.log('STREAM_ERROR', error.message); process.exitCode = 1; }
