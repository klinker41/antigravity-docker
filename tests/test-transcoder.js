const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
    callAnthropicStream,
    callOpenAIStream,
    normalizeJsonSchema,
    geminiToolsToAnthropic,
    geminiToolsToOpenAI,
    geminiContentsToAnthropic,
    geminiContentsToOpenAI
} = require('../proxy/lib/transcoder');

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

    await t.test('converts Gemini uppercase JSON schema types to standard lowercase', () => {
        const geminiSchema = {
            type: 'OBJECT',
            properties: {
                name: { type: 'STRING', description: 'File name' },
                count: { type: 'INTEGER' },
                items: {
                    type: 'ARRAY',
                    items: { type: 'STRING' }
                }
            },
            required: ['name']
        };

        const normalized = normalizeJsonSchema(geminiSchema);
        assert.equal(normalized.type, 'object');
        assert.equal(normalized.properties.name.type, 'string');
        assert.equal(normalized.properties.count.type, 'integer');
        assert.equal(normalized.properties.items.type, 'array');
        assert.equal(normalized.properties.items.items.type, 'string');
    });

    await t.test('converts Gemini tools to Anthropic and OpenAI format', () => {
        const geminiTools = [
            {
                functionDeclarations: [
                    {
                        name: 'run_command',
                        description: 'Executes bash command',
                        parameters: {
                            type: 'OBJECT',
                            properties: { CommandLine: { type: 'STRING' } },
                            required: ['CommandLine']
                        }
                    }
                ]
            }
        ];

        const anthropicTools = geminiToolsToAnthropic(geminiTools);
        assert.equal(anthropicTools.length, 1);
        assert.equal(anthropicTools[0].name, 'run_command');
        assert.equal(anthropicTools[0].input_schema.type, 'object');
        assert.equal(anthropicTools[0].input_schema.properties.CommandLine.type, 'string');

        const openAiTools = geminiToolsToOpenAI(geminiTools);
        assert.equal(openAiTools.length, 1);
        assert.equal(openAiTools[0].type, 'function');
        assert.equal(openAiTools[0].function.name, 'run_command');
        assert.equal(openAiTools[0].function.parameters.type, 'object');
    });

    await t.test('converts Gemini contents to Anthropic messages alternating roles', () => {
        const geminiContents = [
            {
                role: 'user',
                parts: [{ text: 'Please check file.' }]
            },
            {
                role: 'model',
                parts: [
                    { thought: true, text: 'Thinking about the request...' },
                    { text: 'Looking up the file now.' },
                    {
                        functionCall: {
                            name: 'view_file',
                            args: { AbsolutePath: '/workspace/test.txt' }
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'view_file',
                            response: { content: 'File contents here' }
                        }
                    }
                ]
            }
        ];
        const systemInstruction = { parts: [{ text: 'You are Antigravity.' }] };

        const { system, messages } = geminiContentsToAnthropic(geminiContents, systemInstruction);
        assert.equal(system, 'You are Antigravity.');
        assert.equal(messages.length, 3);
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[0].content[0].text, 'Please check file.');

        assert.equal(messages[1].role, 'assistant');
        // Thought part should NOT be included in Anthropic content blocks
        assert.equal(messages[1].content[0].type, 'text');
        assert.equal(messages[1].content[0].text, 'Looking up the file now.');
        assert.equal(messages[1].content[1].type, 'tool_use');
        assert.equal(messages[1].content[1].name, 'view_file');

        assert.equal(messages[2].role, 'user');
        assert.equal(messages[2].content[0].type, 'tool_result');
        assert.equal(messages[2].content[0].tool_use_id, messages[1].content[1].id);
    });

    await t.test('converts Gemini contents to OpenAI messages with system and tools', () => {
        const geminiContents = [
            {
                role: 'user',
                parts: [{ text: 'Run ls' }]
            },
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'run_command',
                            args: { CommandLine: 'ls' }
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'run_command',
                            response: { output: 'file1.txt' }
                        }
                    }
                ]
            }
        ];
        const systemInstruction = { parts: [{ text: 'You are an AI assistant.' }] };

        const messages = geminiContentsToOpenAI(geminiContents, systemInstruction);
        assert.equal(messages[0].role, 'system');
        assert.equal(messages[0].content, 'You are an AI assistant.');
        assert.equal(messages[1].role, 'user');
        assert.equal(messages[1].content, 'Run ls');
        assert.equal(messages[2].role, 'assistant');
        assert.equal(messages[2].tool_calls.length, 1);
        assert.equal(messages[2].tool_calls[0].function.name, 'run_command');
        assert.equal(messages[3].role, 'tool');
        assert.equal(messages[3].tool_call_id, messages[2].tool_calls[0].id);
    });

    await t.test('guarantees top-level type: object on empty or typeless JSON schemas', () => {
        const emptySchema = {};
        const normalized = normalizeJsonSchema(emptySchema);
        assert.equal(normalized.type, 'object');

        const propertiesOnly = { properties: { foo: { type: 'STRING' } } };
        const normProp = normalizeJsonSchema(propertiesOnly);
        assert.equal(normProp.type, 'object');
        assert.equal(normProp.properties.foo.type, 'string');
    });

    await t.test('correctly maps multiple parallel tool calls to the same function via FIFO queue', () => {
        const geminiParallelContents = [
            {
                role: 'user',
                parts: [{ text: 'Read both files' }]
            },
            {
                role: 'model',
                parts: [
                    { functionCall: { id: 'call_first', name: 'view_file', args: { Path: '/a' } } },
                    { functionCall: { id: 'call_second', name: 'view_file', args: { Path: '/b' } } }
                ]
            },
            {
                role: 'user',
                parts: [
                    { functionResponse: { name: 'view_file', response: { content: 'Content A' } } },
                    { functionResponse: { name: 'view_file', response: { content: 'Content B' } } }
                ]
            }
        ];

        // 1. Anthropic mapping
        const { messages: antMessages } = geminiContentsToAnthropic(geminiParallelContents);
        assert.equal(antMessages.length, 3);
        const antAssistant = antMessages[1];
        assert.equal(antAssistant.content[0].id, 'call_first');
        assert.equal(antAssistant.content[1].id, 'call_second');

        const antToolResults = antMessages[2].content;
        assert.equal(antToolResults.length, 2);
        assert.equal(antToolResults[0].tool_use_id, 'call_first');
        assert.equal(antToolResults[1].tool_use_id, 'call_second');

        // 2. OpenAI mapping
        const oaiMessages = geminiContentsToOpenAI(geminiParallelContents);
        assert.equal(oaiMessages.length, 4); // user, assistant, tool 1, tool 2
        assert.equal(oaiMessages[1].tool_calls[0].id, 'call_first');
        assert.equal(oaiMessages[1].tool_calls[1].id, 'call_second');
        assert.equal(oaiMessages[2].tool_call_id, 'call_first');
        assert.equal(oaiMessages[3].tool_call_id, 'call_second');
    });
});
