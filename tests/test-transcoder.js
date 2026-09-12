const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
    callAnthropicStream,
    callOpenAIStream,
    callOpenAIResponsesStream,
    isAdaptiveThinkingModel,
    isOpenAIResponsesModel,
    chatMessagesToResponsesInput,
    chatToolsToResponsesTools,
    normalizeJsonSchema,
    geminiToolsToAnthropic,
    geminiToolsToOpenAI,
    geminiContentsToAnthropic,
    geminiContentsToOpenAI,
    getFunctionCall,
    getFunctionResponse,
    extractResponseValue,
    resolveToolCallId
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
        assert.equal(normalized.properties.type, undefined, 'properties dictionary must not have a type property injected');

        const emptyNormalized = normalizeJsonSchema({});
        assert.equal(emptyNormalized.type, 'object');
        assert.deepEqual(emptyNormalized.properties, {});

        const nestedSchema = {
            type: 'OBJECT',
            properties: {
                metadata: {
                    type: 'OBJECT',
                    properties: {
                        tag: { type: 'STRING' }
                    }
                }
            }
        };
        const nestedNormalized = normalizeJsonSchema(nestedSchema);
        assert.equal(nestedNormalized.properties.metadata.type, 'object');
        assert.equal(nestedNormalized.properties.metadata.properties.tag.type, 'string');
        assert.equal(nestedNormalized.properties.metadata.properties.type, undefined);
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
        assert.equal(anthropicTools[0].input_schema.properties.type, undefined);

        const openAiTools = geminiToolsToOpenAI(geminiTools);
        assert.equal(openAiTools.length, 1);
        assert.equal(openAiTools[0].type, 'function');
        assert.equal(openAiTools[0].function.name, 'run_command');
        assert.equal(openAiTools[0].function.parameters.type, 'object');
        assert.equal(openAiTools[0].function.parameters.properties.CommandLine.type, 'string');
        assert.equal(openAiTools[0].function.parameters.properties.type, undefined);
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

    await t.test('detects Anthropic adaptive thinking models and configures payloads appropriately', async () => {
        // Model detection
        assert.equal(isAdaptiveThinkingModel('claude-fable-5-1'), true);
        assert.equal(isAdaptiveThinkingModel('claude-fable-5'), true);
        assert.equal(isAdaptiveThinkingModel('claude-opus-5'), true);
        assert.equal(isAdaptiveThinkingModel('claude-sonnet-5'), true);
        assert.equal(isAdaptiveThinkingModel('claude-opus-4-8'), true);
        assert.equal(isAdaptiveThinkingModel('claude-sonnet-4-6'), true);
        assert.equal(isAdaptiveThinkingModel('claude-opus-4-6'), true);
        assert.equal(isAdaptiveThinkingModel('claude-opus-4-5-20251101'), false);
        assert.equal(isAdaptiveThinkingModel('claude-3-7-sonnet'), false);

        // Server verifying payload structure
        let receivedThinking = null;
        const mockAdaptiveServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                const parsed = JSON.parse(body);
                receivedThinking = parsed.thinking;
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('data: {"type":"message_stop"}\n\n');
                res.end();
            });
        });
        await new Promise((resolve) => mockAdaptiveServer.listen(0, '127.0.0.1', resolve));
        const adaptivePort = mockAdaptiveServer.address().port;

        // Fable 5.1 -> adaptive thinking
        await callAnthropicStream({
            endpoint: `http://127.0.0.1:${adaptivePort}`,
            apiKey: 'test-key',
            model: 'claude-fable-5-1',
            messages: [{ role: 'user', content: 'Hi' }],
            supportsThinking: true,
            onEvent: () => {}
        });
        assert.deepEqual(receivedThinking, { type: 'adaptive' });

        // Claude 3.7 Sonnet -> enabled thinking with budget_tokens
        await callAnthropicStream({
            endpoint: `http://127.0.0.1:${adaptivePort}`,
            apiKey: 'test-key',
            model: 'claude-3-7-sonnet',
            messages: [{ role: 'user', content: 'Hi' }],
            supportsThinking: true,
            onEvent: () => {}
        });
        assert.deepEqual(receivedThinking, { type: 'enabled', budget_tokens: 2048 });

        mockAdaptiveServer.close();
    });

    await t.test('transparently retries Anthropic request if thinking mode is rejected with 400', async () => {
        let attempts = 0;
        const mockRetryServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                attempts++;
                const parsed = JSON.parse(body);
                if (attempts === 1) {
                    // First attempt simulates error: thinking.type.enabled is not supported
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        type: 'error',
                        error: {
                            type: 'invalid_request_error',
                            message: '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.'
                        }
                    }));
                } else {
                    assert.deepEqual(parsed.thinking, { type: 'adaptive' });
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
                    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Recovered!"}}\n\n');
                    res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
                    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
                    res.end();
                }
            });
        });
        await new Promise((resolve) => mockRetryServer.listen(0, '127.0.0.1', resolve));
        const retryPort = mockRetryServer.address().port;

        const events = [];
        await callAnthropicStream({
            endpoint: `http://127.0.0.1:${retryPort}`,
            apiKey: 'test-key',
            model: 'custom-claude-unknown',
            messages: [{ role: 'user', content: 'Hi' }],
            supportsThinking: true,
            onEvent: (ev) => events.push(ev)
        });

        assert.equal(attempts, 2);
        assert.equal(events.find(e => e.type === 'text')?.text, 'Recovered!');
        mockRetryServer.close();
    });

    await t.test('detects OpenAI Responses API models and converts messages/tools to Responses API format', () => {
        assert.equal(isOpenAIResponsesModel('gpt-6-astra'), true);
        assert.equal(isOpenAIResponsesModel('gpt-6'), true);
        assert.equal(isOpenAIResponsesModel('o1-preview'), true);
        assert.equal(isOpenAIResponsesModel('o3-mini'), true);
        assert.equal(isOpenAIResponsesModel('gpt-4o'), false);
        assert.equal(isOpenAIResponsesModel('gemma4:e2b'), false);

        const chatMessages = [
            { role: 'system', content: 'You are an agent' },
            { role: 'user', content: 'Run command' },
            {
                role: 'assistant',
                content: 'Running...',
                tool_calls: [
                    {
                        id: 'call_cmd1',
                        type: 'function',
                        function: { name: 'run_command', arguments: '{"CommandLine":"ls"}' }
                    }
                ]
            },
            {
                role: 'tool',
                tool_call_id: 'call_cmd1',
                content: 'file1.txt\nfile2.txt'
            }
        ];

        const responsesInput = chatMessagesToResponsesInput(chatMessages);
        assert.equal(responsesInput.length, 5);
        assert.deepEqual(responsesInput[0], { role: 'system', content: 'You are an agent' });
        assert.deepEqual(responsesInput[1], { role: 'user', content: 'Run command' });
        assert.deepEqual(responsesInput[2], { role: 'assistant', content: 'Running...' });
        assert.deepEqual(responsesInput[3], {
            type: 'function_call',
            call_id: 'call_cmd1',
            name: 'run_command',
            arguments: '{"CommandLine":"ls"}'
        });
        assert.deepEqual(responsesInput[4], {
            type: 'function_call_output',
            call_id: 'call_cmd1',
            output: 'file1.txt\nfile2.txt'
        });

        const chatTools = [
            {
                type: 'function',
                function: {
                    name: 'run_command',
                    description: 'Run shell command',
                    parameters: { type: 'object', properties: {} }
                }
            }
        ];
        const responsesTools = chatToolsToResponsesTools(chatTools);
        assert.equal(responsesTools.length, 1);
        assert.deepEqual(responsesTools[0], {
            type: 'function',
            name: 'run_command',
            description: 'Run shell command',
            parameters: { type: 'object', properties: {} }
        });
    });

    await t.test('streams and normalizes OpenAI Responses API events (/v1/responses)', async () => {
        const mockResponsesServer = http.createServer((req, res) => {
            assert.equal(req.url, '/v1/responses');
            assert.equal(req.headers['authorization'], 'Bearer test-openai-key');

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache'
            });

            // Reasoning delta
            res.write('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Planning the execution..."}\n\n');

            // Text delta
            res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Calling the function..."}\n\n');

            // Function call item added & arguments delta
            res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_123","name":"run_command","arguments":""}}\n\n');
            res.write('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"Command\\"}\n\n');
            res.write('event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"CommandLine\\":\\"echo hello\\"}"}\n\n');
            res.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","call_id":"call_123","name":"run_command","arguments":"{\\"CommandLine\\":\\"echo hello\\"}"}}\n\n');

            // Completion
            res.write('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
            res.end();
        });

        await new Promise((resolve) => mockResponsesServer.listen(0, '127.0.0.1', resolve));
        const respPort = mockResponsesServer.address().port;

        const events = [];
        await callOpenAIResponsesStream({
            endpoint: `http://127.0.0.1:${respPort}`,
            apiKey: 'test-openai-key',
            model: 'gpt-6-astra',
            messages: [{ role: 'user', content: 'Run hello' }],
            onEvent: (ev) => events.push(ev)
        });

        mockResponsesServer.close();

        const thoughts = events.filter(e => e.type === 'thought').map(e => e.text).join('');
        assert.equal(thoughts, 'Planning the execution...');

        const text = events.filter(e => e.type === 'text').map(e => e.text).join('');
        assert.equal(text, 'Calling the function...');

        const tools = events.filter(e => e.type === 'tool_call');
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, 'run_command');
        assert.equal(tools[0].id, 'call_123');
        assert.deepEqual(JSON.parse(tools[0].arguments), { CommandLine: 'echo hello' });

        const done = events.find(e => e.type === 'done');
        assert.ok(done);
        assert.equal(done.finishReason, 'STOP');
    });

    await t.test('callOpenAIStream automatically routes gpt-6-astra to Responses API', async () => {
        let routedToResponses = false;
        const mockServer = http.createServer((req, res) => {
            if (req.url === '/v1/responses') {
                routedToResponses = true;
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Astra routed!"}\n\n');
                res.write('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
                res.end();
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end('{"error":{"message":"Should not call completions"}}');
            }
        });

        await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
        const port = mockServer.address().port;

        const events = [];
        await callOpenAIStream({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'gpt-6-astra',
            messages: [{ role: 'user', content: 'Hi' }],
            onEvent: (ev) => events.push(ev)
        });

        mockServer.close();
        assert.equal(routedToResponses, true);
        assert.equal(events.find(e => e.type === 'text')?.text, 'Astra routed!');
    });

    await t.test('callOpenAIStream falls back to Responses API when chat completions returns 400 with /v1/responses', async () => {
        let attempts = 0;
        const mockServer = http.createServer((req, res) => {
            attempts++;
            if (req.url === '/v1/chat/completions') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: "Function tools with reasoning_effort are not supported for custom-model in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."
                    }
                }));
            } else if (req.url === '/v1/responses') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Fell back to responses!"}\n\n');
                res.write('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
                res.end();
            }
        });

        await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
        const port = mockServer.address().port;

        const events = [];
        await callOpenAIStream({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'custom-reasoning-model',
            messages: [{ role: 'user', content: 'Hi' }],
            tools: [{ type: 'function', function: { name: 'fn', parameters: {} } }],
            onEvent: (ev) => events.push(ev)
        });

        mockServer.close();
        assert.equal(attempts, 2);
        assert.equal(events.find(e => e.type === 'text')?.text, 'Fell back to responses!');
    });

    await t.test('callAnthropicStream sets budget_tokens and max_tokens based on thinkingLevel', async () => {
        let capturedPayload = null;
        const mockServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                capturedPayload = JSON.parse(body);
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
                res.end();
            });
        });

        await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
        const port = mockServer.address().port;

        // Test High thinking level
        await callAnthropicStream({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'claude-3-7-sonnet',
            messages: [{ role: 'user', content: 'Hi' }],
            supportsThinking: true,
            thinkingLevel: 'high',
            onEvent: () => {}
        });

        assert.equal(capturedPayload.thinking.type, 'enabled');
        assert.equal(capturedPayload.thinking.budget_tokens, 32768);
        assert.ok(capturedPayload.max_tokens >= 36864);

        // Test Low thinking level
        await callAnthropicStream({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'claude-3-7-sonnet',
            messages: [{ role: 'user', content: 'Hi' }],
            supportsThinking: true,
            thinkingLevel: 'low',
            onEvent: () => {}
        });

        assert.equal(capturedPayload.thinking.type, 'enabled');
        assert.equal(capturedPayload.thinking.budget_tokens, 2048);

        // Test Medium thinking level
        await callAnthropicStream({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'claude-3-7-sonnet',
            messages: [{ role: 'user', content: 'Hi' }],
            supportsThinking: true,
            thinkingLevel: 'medium',
            onEvent: () => {}
        });

        assert.equal(capturedPayload.thinking.type, 'enabled');
        assert.equal(capturedPayload.thinking.budget_tokens, 8192);

        mockServer.close();
    });

    await t.test('callOpenAIStream and callOpenAIResponsesStream set reasoning effort based on thinkingLevel', async () => {
        let capturedChatPayload = null;
        let capturedResponsesPayload = null;

        const mockServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                if (req.url === '/v1/chat/completions') {
                    capturedChatPayload = JSON.parse(body);
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
                    res.write('data: [DONE]\n\n');
                    res.end();
                } else if (req.url === '/v1/responses') {
                    capturedResponsesPayload = JSON.parse(body);
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write('event: response.completed\ndata: {"type":"response.completed"}\n\n');
                    res.end();
                }
            });
        });

        await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
        const port = mockServer.address().port;

        // 1. Chat completions with thinkingLevel
        await callOpenAIStream({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'deepseek-r1',
            messages: [{ role: 'user', content: 'Hi' }],
            supportsThinking: true,
            thinkingLevel: 'high',
            onEvent: () => {}
        });

        assert.ok(capturedChatPayload);
        assert.equal(capturedChatPayload.reasoning_effort, 'high');

        // 2. Responses API with thinkingLevel
        await callOpenAIResponsesStream({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'o3',
            messages: [{ role: 'user', content: 'Hi' }],
            supportsThinking: true,
            thinkingLevel: 'medium',
            onEvent: () => {}
        });

        assert.ok(capturedResponsesPayload);
        assert.deepEqual(capturedResponsesPayload.reasoning, { effort: 'medium' });

        mockServer.close();
    });

    await t.test('callOpenAIStream retries without reasoning_effort on HTTP 400 or 422 rejection', async () => {
        let attempts = 0;
        const capturedBodies = [];
        const mockServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                attempts++;
                const parsed = JSON.parse(body);
                capturedBodies.push(parsed);
                if (attempts === 1) {
                    res.writeHead(422, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Unknown parameter: reasoning_effort' } }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write('data: {"choices":[{"delta":{"content":"recovered without reasoning effort"}}]}\n\n');
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
            });
        });

        await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
        const port = mockServer.address().port;

        const events = [];
        await callOpenAIStream({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'deepseek-r1',
            messages: [{ role: 'user', content: 'Hi' }],
            supportsThinking: true,
            thinkingLevel: 'medium',
            onEvent: (event) => events.push(event)
        });

        assert.equal(attempts, 2);
        assert.equal(capturedBodies[0].reasoning_effort, 'medium');
        assert.equal(capturedBodies[1].reasoning_effort, undefined);
        assert.equal(events.find(e => e.type === 'text')?.text, 'recovered without reasoning effort');

        mockServer.close();
    });

    await t.test('getFunctionCall and getFunctionResponse handle camelCase and snake_case keys', () => {
        // camelCase
        const call1 = getFunctionCall({ functionCall: { name: 'view_file', args: { path: '/a' }, id: 'call_1' } });
        assert.deepEqual(call1, { name: 'view_file', args: { path: '/a' }, id: 'call_1' });

        // snake_case
        const call2 = getFunctionCall({ function_call: { name: 'view_file', arguments: { path: '/b' } } });
        assert.deepEqual(call2, { name: 'view_file', args: { path: '/b' }, id: null });

        // camelCase response
        const resp1 = getFunctionResponse({ functionResponse: { name: 'view_file', response: { content: 'ok' }, id: 'uuid-1' } });
        assert.deepEqual(resp1, { name: 'view_file', response: { content: 'ok' }, id: 'uuid-1' });

        // snake_case response
        const resp2 = getFunctionResponse({ function_response: { name: 'view_file', response: 'file content' } });
        assert.deepEqual(resp2, { name: 'view_file', response: 'file content', id: null });

        // toolResponse / tool_response
        const resp3 = getFunctionResponse({ toolResponse: { name: 'exec', output: { exitCode: 0 } } });
        assert.deepEqual(resp3, { name: 'exec', response: { exitCode: 0 }, id: null });

        // invalid
        assert.equal(getFunctionCall({ text: 'hi' }), null);
        assert.equal(getFunctionResponse({ text: 'hi' }), null);
    });

    await t.test('geminiContentsToOpenAI and geminiContentsToAnthropic resolve mismatched/step-UUID response IDs', () => {
        const contents = [
            {
                role: 'user',
                parts: [{ text: 'Please check the file' }]
            },
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'view_file',
                            args: { AbsolutePath: '/workspace/test.txt' },
                            id: 'call_77dmBdLVZtd0B6VabLNsPyKg'
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        function_response: {
                            name: 'view_file',
                            id: '5cf6b004-cad6-4d2c-b487-9720dcb29a41', // Step UUID from agy wire data
                            response: { content: 'File contents here' }
                        }
                    }
                ]
            }
        ];

        // 1. Test OpenAI conversion
        const openAiMessages = geminiContentsToOpenAI(contents);
        assert.equal(openAiMessages.length, 3);
        assert.equal(openAiMessages[0].role, 'user');
        assert.equal(openAiMessages[1].role, 'assistant');
        assert.equal(openAiMessages[1].tool_calls?.[0]?.id, 'call_77dmBdLVZtd0B6VabLNsPyKg');
        assert.equal(openAiMessages[2].role, 'tool');
        // Critical invariant: tool_call_id MUST match the tool call's ID, not the step UUID
        assert.equal(openAiMessages[2].tool_call_id, 'call_77dmBdLVZtd0B6VabLNsPyKg');
        assert.deepEqual(JSON.parse(openAiMessages[2].content), { content: 'File contents here' });

        // 2. Test Anthropic conversion
        const { messages: anthropicMessages } = geminiContentsToAnthropic(contents);
        assert.equal(anthropicMessages.length, 3);
        assert.equal(anthropicMessages[1].role, 'assistant');
        assert.equal(anthropicMessages[1].content[0].type, 'tool_use');
        assert.equal(anthropicMessages[1].content[0].id, 'call_77dmBdLVZtd0B6VabLNsPyKg');
        assert.equal(anthropicMessages[2].role, 'user');
        assert.equal(anthropicMessages[2].content[0].type, 'tool_result');
        assert.equal(anthropicMessages[2].content[0].tool_use_id, 'call_77dmBdLVZtd0B6VabLNsPyKg');
    });

    await t.test('geminiContentsToOpenAI matches by global pending queue if name is omitted in function_response', () => {
        const contents = [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'run_cmd',
                            args: { cmd: 'ls' },
                            id: 'call_cmd_123'
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        function_response: {
                            // name omitted
                            id: 'internal-step-id',
                            response: 'file1.txt'
                        }
                    }
                ]
            }
        ];

        const openAiMessages = geminiContentsToOpenAI(contents);
        assert.equal(openAiMessages[1].role, 'tool');
        assert.equal(openAiMessages[1].tool_call_id, 'call_cmd_123');
        assert.equal(openAiMessages[1].content, 'file1.txt');
    });

    await t.test('chatMessagesToResponsesInput remaps unknown call IDs and synthesizes outputs for orphaned calls', () => {
        const messages = [
            {
                role: 'user',
                content: 'Help me'
            },
            {
                role: 'assistant',
                content: 'Running tool',
                tool_calls: [
                    {
                        id: 'call_foo_999',
                        function: { name: 'list_dir', arguments: '{"path":"/tmp"}' }
                    },
                    {
                        id: 'call_bar_888',
                        function: { name: 'read_url', arguments: '{"url":"http://test"}' }
                    }
                ]
            },
            {
                role: 'tool',
                tool_call_id: 'call_unknown', // Mismatched or unknown tool_call_id
                content: 'dir contents'
            }
            // Note: call_bar_888 has no tool output in messages
        ];

        const input = chatMessagesToResponsesInput(messages);

        // Verify call_foo_999 was properly paired with the tool output
        const callOutputs = input.filter(i => i.type === 'function_call_output');
        assert.equal(callOutputs.length, 2, 'Must have 2 outputs (one remapped, one synthesized)');

        const firstOutput = callOutputs.find(o => o.call_id === 'call_foo_999');
        assert.ok(firstOutput, 'First output must be remapped to call_foo_999');
        assert.equal(firstOutput.output, 'dir contents');

        // Verify call_bar_888 received a synthesized empty output
        const secondOutput = callOutputs.find(o => o.call_id === 'call_bar_888');
        assert.ok(secondOutput, 'Second orphaned output must be synthesized for call_bar_888');
        assert.equal(secondOutput.output, '{}');
    });

    await t.test('callOpenAIResponsesStream guarantees all function_call items have matching function_call_output items', async () => {
        let capturedPayload = null;

        const mockServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                capturedPayload = JSON.parse(body);

                // Strict validation matching OpenAI Responses API:
                // Every function_call MUST have an exact function_call_output
                const functionCalls = capturedPayload.input.filter(i => i.type === 'function_call');
                const functionOutputs = capturedPayload.input.filter(i => i.type === 'function_call_output');

                for (const fc of functionCalls) {
                    const match = functionOutputs.find(fo => fo.call_id === fc.call_id);
                    if (!match) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: {
                                message: `No tool output found for function call ${fc.call_id}.`,
                                type: 'invalid_request_error',
                                param: 'input',
                                code: null
                            }
                        }));
                        return;
                    }
                }

                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('event: response.output_text.delta\ndata: {"delta":"Tool execution verified"}\n\n');
                res.write('event: response.completed\ndata: {"type":"response.completed"}\n\n');
                res.end();
            });
        });

        await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
        const port = mockServer.address().port;

        const geminiContents = [
            {
                role: 'user',
                parts: [{ text: 'Read the file' }]
            },
            {
                role: 'model',
                parts: [{
                    functionCall: {
                        name: 'view_file',
                        args: { AbsolutePath: '/workspace/README.md' },
                        id: 'call_77dmBdLVZtd0B6VabLNsPyKg'
                    }
                }]
            },
            {
                role: 'user',
                parts: [{
                    function_response: {
                        name: 'view_file',
                        id: '5cf6b004-cad6-4d2c-b487-9720dcb29a41', // Step UUID
                        response: { content: '# Antigravity' }
                    }
                }]
            }
        ];

        // Transcode through geminiContentsToOpenAI
        const messages = geminiContentsToOpenAI(geminiContents);

        const events = [];
        await callOpenAIResponsesStream({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'gpt-6-astra',
            messages,
            onEvent: (ev) => events.push(ev)
        });

        assert.ok(capturedPayload);
        const text = events.filter(e => e.type === 'text').map(e => e.text).join('');
        assert.equal(text, 'Tool execution verified');

        // Verify payload call_id matching
        const calls = capturedPayload.input.filter(i => i.type === 'function_call');
        const outputs = capturedPayload.input.filter(i => i.type === 'function_call_output');
        assert.equal(calls.length, 1);
        assert.equal(outputs.length, 1);
        assert.equal(calls[0].call_id, 'call_77dmBdLVZtd0B6VabLNsPyKg');
        assert.equal(outputs[0].call_id, 'call_77dmBdLVZtd0B6VabLNsPyKg');

        mockServer.close();
    });

    await t.test('resolveToolCallId correctly handles direct matches, name matches, and queue fallbacks without desync', () => {
        const pending = [
            { id: 'call_1', name: 'tool_a' },
            { id: 'call_2', name: 'tool_b' },
            { id: 'call_3', name: 'tool_a' }
        ];
        const known = new Set(['call_1', 'call_2', 'call_3']);

        // 1. Name match should take the earliest matching name
        const idA = resolveToolCallId({ name: 'tool_a', id: 'some-step-uuid' }, pending, known, 'call');
        assert.equal(idA, 'call_1');
        assert.equal(pending.length, 2);

        // 2. Direct match by ID
        const idB = resolveToolCallId({ name: 'tool_b', id: 'call_2' }, pending, known, 'call');
        assert.equal(idB, 'call_2');
        assert.equal(pending.length, 1);

        // 3. Fallback when name is unknown/omitted
        const idC = resolveToolCallId({ name: '', id: 'other-uuid' }, pending, known, 'call');
        assert.equal(idC, 'call_3');
        assert.equal(pending.length, 0);

        // 4. Default fallback when queue empty
        const idD = resolveToolCallId({ name: 'tool_x', id: '' }, pending, known, 'toolu');
        assert.equal(idD, 'toolu_unknown');
    });

    await t.test('geminiContentsToAnthropic parses stringified JSON args into objects', () => {
        const contents = [
            {
                role: 'user',
                parts: [{ text: 'Run command' }]
            },
            {
                role: 'model',
                parts: [{
                    function_call: {
                        name: 'run_command',
                        arguments: '{"CommandLine":"echo 123"}'
                    }
                }]
            }
        ];

        const { messages } = geminiContentsToAnthropic(contents);
        assert.equal(messages.length, 2);
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[1].role, 'assistant');
        const toolBlock = messages[1].content[0];
        assert.equal(toolBlock.type, 'tool_use');
        assert.equal(typeof toolBlock.input, 'object');
        assert.deepEqual(toolBlock.input, { CommandLine: 'echo 123' });
    });

    await t.test('chatMessagesToResponsesInput flushes orphaned outputs before subsequent user messages', () => {
        const messages = [
            { role: 'user', content: 'First prompt' },
            {
                role: 'assistant',
                content: 'Thinking',
                tool_calls: [{ id: 'call_orphan_1', function: { name: 'f1', arguments: '{}' } }]
            },
            // User speaks again without tool response
            { role: 'user', content: 'Second prompt' }
        ];

        const input = chatMessagesToResponsesInput(messages);
        // Desired ordering:
        // [user: First prompt, assistant: Thinking, function_call: call_orphan_1, function_call_output: call_orphan_1, user: Second prompt]
        assert.equal(input.length, 5);
        assert.equal(input[0].role, 'user');
        assert.equal(input[1].role, 'assistant');
        assert.equal(input[2].type, 'function_call');
        assert.equal(input[2].call_id, 'call_orphan_1');
        assert.equal(input[3].type, 'function_call_output');
        assert.equal(input[3].call_id, 'call_orphan_1');
        assert.equal(input[3].output, '{}');
        assert.equal(input[4].role, 'user');
        assert.equal(input[4].content, 'Second prompt');
    });

    await t.test('extractResponseValue decodes base64 string data from parts', () => {
        const b64 = Buffer.from('TOOL_CHECK\nfile1.txt\n', 'utf8').toString('base64');
        const part = {
            functionResponse: {
                name: 'run_command',
                id: 'call_cmd_1',
                parts: [{ data: b64 }]
            }
        };

        const fnResp = getFunctionResponse(part);
        assert.ok(fnResp);
        assert.equal(fnResp.name, 'run_command');
        assert.equal(fnResp.id, 'call_cmd_1');
        assert.equal(fnResp.response, 'TOOL_CHECK\nfile1.txt\n');
    });

    await t.test('extractResponseValue decodes base64 inlineData from parts', () => {
        const b64 = Buffer.from('console.log("hello")', 'utf8').toString('base64');
        const part = {
            functionResponse: {
                name: 'view_file',
                id: 'call_vf_1',
                parts: [{
                    inlineData: {
                        mimeType: 'text/plain',
                        data: b64
                    }
                }]
            }
        };

        const fnResp = getFunctionResponse(part);
        assert.ok(fnResp);
        assert.equal(fnResp.response, 'console.log("hello")');
    });

    await t.test('extractResponseValue captures error details on tool failure or permission denial', () => {
        const part = {
            functionResponse: {
                name: 'read_url_content',
                id: 'call_url_1',
                response: {},
                error: 'permission check failed: user denied permission'
            }
        };

        const fnResp = getFunctionResponse(part);
        assert.ok(fnResp);
        assert.equal(fnResp.response, 'Error: permission check failed: user denied permission');
    });

    await t.test('geminiContentsToOpenAI includes decoded tool response parts in tool message content', () => {
        const b64 = Buffer.from('echo test output', 'utf8').toString('base64');
        const contents = [
            {
                role: 'model',
                parts: [{
                    functionCall: {
                        name: 'run_command',
                        id: 'call_100',
                        args: { CommandLine: 'echo test' }
                    }
                }]
            },
            {
                role: 'user',
                parts: [{
                    functionResponse: {
                        name: 'run_command',
                        id: 'call_100',
                        parts: [{ data: b64 }]
                    }
                }]
            }
        ];

        const messages = geminiContentsToOpenAI(contents);
        const toolMsg = messages.find(m => m.role === 'tool');
        assert.ok(toolMsg);
        assert.equal(toolMsg.tool_call_id, 'call_100');
        assert.equal(toolMsg.content, 'echo test output');
    });
});

