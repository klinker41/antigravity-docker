const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { callAnthropicStream, callOpenAIStream } = require('../proxy/lib/transcoder');

test('Stream Transcoder - Anthropic & OpenAI Event Normalization', async (t) => {
    // 1. Mock Anthropic SSE Stream Server
    const mockAnthropic = http.createServer((req, res) => {
        assert.equal(req.headers['x-api-key'], 'test-anthropic-key');
        assert.equal(req.headers['anthropic-version'], '2023-06-01');

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // Emit thinking block
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Analyzing the task..."}}\n\n');
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');

        // Emit text block
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Here is the solution."}}\n\n');
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n');

        // Emit tool_use block
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool_call_1","name":"run_command","input":{}}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"Command"}} \n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"Line\\":\\"ls\\"}"}}\n\n');
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n');

        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
    });

    await new Promise((resolve) => mockAnthropic.listen(0, '127.0.0.1', resolve));
    const anthropicPort = mockAnthropic.address().port;

    t.after(() => {
        mockAnthropic.close();
    });

    await t.test('normalizes Anthropic thinking, text, and tool_use SSE events', async () => {
        const events = [];
        await callAnthropicStream({
            endpoint: `http://127.0.0.1:${anthropicPort}`,
            apiKey: 'test-anthropic-key',
            model: 'claude-3-7-sonnet',
            messages: [{ role: 'user', content: 'Hello' }],
            onEvent: (ev) => events.push(ev)
        });

        const thoughts = events.filter(e => e.type === 'thought').map(e => e.text).join('');
        assert.equal(thoughts, 'Analyzing the task...');

        const text = events.filter(e => e.type === 'text').map(e => e.text).join('');
        assert.equal(text, 'Here is the solution.');

        const tools = events.filter(e => e.type === 'tool_call');
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, 'run_command');
        assert.equal(tools[0].id, 'tool_call_1');
        assert.deepEqual(JSON.parse(tools[0].arguments), { CommandLine: 'ls' });
    });

    // 2. Mock OpenAI SSE Stream Server
    const mockOpenAI = http.createServer((req, res) => {
        assert.equal(req.headers['authorization'], 'Bearer test-openai-key');

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache'
        });

        res.write('data: {"choices":[{"delta":{"content":"Hello world"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"view_file","arguments":"{\\"AbsolutePath\\":\\"/a\\""}}]}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
    });

    await new Promise((resolve) => mockOpenAI.listen(0, '127.0.0.1', resolve));
    const openaiPort = mockOpenAI.address().port;

    await t.test('normalizes OpenAI streaming delta chunks into unified events', async () => {
        const events = [];
        await callOpenAIStream({
            endpoint: `http://127.0.0.1:${openaiPort}/v1/chat/completions`,
            apiKey: 'test-openai-key',
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hi' }],
            onEvent: (ev) => events.push(ev)
        });

        mockOpenAI.close();

        const text = events.filter(e => e.type === 'text').map(e => e.text).join('');
        assert.equal(text, 'Hello world');

        const tools = events.filter(e => e.type === 'tool_call');
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, 'view_file');
        assert.equal(tools[0].id, 'call_abc');
        assert.deepEqual(JSON.parse(tools[0].arguments), { AbsolutePath: '/a' });
    });
});
