const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
    isEffectivelyEmpty,
    resolveToolCallId,
    sanitizeToolCallArgs,
    unpackProtobufValue,
    formatToolSuccessFallback,
    prepareToolResponses,
    isToolExecutionOutput,
    resolveConversationToolOutputs,
    createToolOutputResolver
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
        assert.deepEqual(resp1, { name: 'view_file', response: 'ok', id: 'uuid-1' });

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
        assert.equal(openAiMessages[2].content, 'File contents here');

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

        // Verify call_bar_888 received a synthesized fallback output (never '{}')
        const secondOutput = callOutputs.find(o => o.call_id === 'call_bar_888');
        assert.ok(secondOutput, 'Second orphaned output must be synthesized for call_bar_888');
        assert.equal(secondOutput.output, 'Web content retrieved with no additional output.');
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
        assert.equal(input[3].output, 'Tool executed successfully with no additional output.');
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

    await t.test('geminiContentsToOpenAI partitions tool responses before user text in mixed turns', () => {
        const contents = [
            {
                role: 'model',
                parts: [{
                    functionCall: {
                        name: 'view_file',
                        id: 'call_view_1',
                        args: { AbsolutePath: '/workspace/test.txt' }
                    }
                }]
            },
            {
                role: 'user',
                parts: [
                    { text: 'Intervening commentary before tool response' },
                    {
                        functionResponse: {
                            name: 'view_file',
                            id: 'call_view_1',
                            response: { content: 'hello world file content' }
                        }
                    }
                ]
            }
        ];

        const messages = geminiContentsToOpenAI(contents);
        assert.equal(messages.length, 3);
        assert.equal(messages[0].role, 'assistant');
        assert.equal(messages[1].role, 'tool');
        assert.equal(messages[1].tool_call_id, 'call_view_1');
        assert.equal(messages[1].content, 'hello world file content');
        assert.equal(messages[2].role, 'user');
        assert.equal(messages[2].content, 'Intervening commentary before tool response');
    });

    await t.test('chatMessagesToResponsesInput pairs tool calls with real outputs when user text is present', () => {
        const messages = [
            {
                role: 'user',
                content: 'Please inspect the repo'
            },
            {
                role: 'assistant',
                tool_calls: [
                    {
                        id: 'call_cmd_1',
                        type: 'function',
                        function: {
                            name: 'run_command',
                            arguments: '{"CommandLine":"printf \'tool-output-check\\n\'"}'
                        }
                    },
                    {
                        id: 'call_view_1',
                        type: 'function',
                        function: {
                            name: 'view_file',
                            arguments: '{"AbsolutePath":"/workspace/test.md"}'
                        }
                    }
                ]
            },
            {
                role: 'tool',
                tool_call_id: 'call_cmd_1',
                content: 'The command exited with code 0.\nOutput:\ntool-output-check\n'
            },
            {
                role: 'tool',
                tool_call_id: 'call_view_1',
                content: '# Test Document\n\nContent here'
            },
            {
                role: 'user',
                content: 'Check on checkpoint progress'
            }
        ];

        const input = chatMessagesToResponsesInput(messages);
        assert.equal(input.length, 6);
        assert.deepEqual(input[0], { role: 'user', content: 'Please inspect the repo' });
        assert.equal(input[1].type, 'function_call');
        assert.equal(input[1].call_id, 'call_cmd_1');
        assert.equal(input[2].type, 'function_call');
        assert.equal(input[2].call_id, 'call_view_1');

        assert.equal(input[3].type, 'function_call_output');
        assert.equal(input[3].call_id, 'call_cmd_1');
        assert.equal(input[3].output, 'The command exited with code 0.\nOutput:\ntool-output-check\n');

        assert.equal(input[4].type, 'function_call_output');
        assert.equal(input[4].call_id, 'call_view_1');
        assert.equal(input[4].output, '# Test Document\n\nContent here');

        assert.deepEqual(input[5], { role: 'user', content: 'Check on checkpoint progress' });
    });

    await t.test('chatMessagesToResponsesInput falls back to empty object only for truly orphaned calls', () => {
        const messages = [
            {
                role: 'assistant',
                tool_calls: [
                    {
                        id: 'call_answered',
                        type: 'function',
                        function: { name: 'run_command', arguments: '{}' }
                    },
                    {
                        id: 'call_orphaned',
                        type: 'function',
                        function: { name: 'run_command', arguments: '{}' }
                    }
                ]
            },
            {
                role: 'tool',
                tool_call_id: 'call_answered',
                content: 'Real answer output'
            }
        ];

        const input = chatMessagesToResponsesInput(messages);
        assert.equal(input.length, 4);
        assert.equal(input[0].type, 'function_call');
        assert.equal(input[0].call_id, 'call_answered');
        assert.equal(input[1].type, 'function_call');
        assert.equal(input[1].call_id, 'call_orphaned');

        assert.equal(input[2].type, 'function_call_output');
        assert.equal(input[2].call_id, 'call_answered');
        assert.equal(input[2].output, 'Real answer output');

        assert.equal(input[3].type, 'function_call_output');
        assert.equal(input[3].call_id, 'call_orphaned');
        assert.equal(input[3].output, 'Command executed.');
    });

    await t.test('geminiToolsToOpenAI and geminiToolsToAnthropic support snake_case function_declarations', () => {
        const tools = [
            {
                function_declarations: [
                    {
                        name: 'custom_search',
                        description: 'Custom search tool',
                        parameters: {
                            type: 'OBJECT',
                            properties: { query: { type: 'STRING' } }
                        }
                    }
                ]
            }
        ];

        const openAiTools = geminiToolsToOpenAI(tools);
        assert.ok(openAiTools);
        assert.equal(openAiTools.length, 1);
        assert.equal(openAiTools[0].function.name, 'custom_search');

        const anthropicTools = geminiToolsToAnthropic(tools);
        assert.ok(anthropicTools);
        assert.equal(anthropicTools.length, 1);
        assert.equal(anthropicTools[0].name, 'custom_search');
    });

    await t.test('sanitizeToolCallArgs strips ArtifactMetadata for project files and coerces types', () => {
        // 1. write_to_file outside artifact dir (e.g. project workspace)
        const projectWrite = sanitizeToolCallArgs('write_to_file', {
            TargetFile: '/workspace/llm-plays-pokemon/write-access-test.txt',
            CodeContent: 'File write test successful.\n',
            Description: 'Create a small test file to verify project write access.',
            Overwrite: 'false',
            ArtifactMetadata: {
                RequestFeedback: false,
                Summary: 'Temporary file write verification.',
                UserFacing: false
            },
            toolAction: 'Testing file write',
            toolSummary: 'Project write verification'
        });

        assert.equal(projectWrite.TargetFile, '/workspace/llm-plays-pokemon/write-access-test.txt');
        assert.equal(projectWrite.Overwrite, true);
        assert.equal(projectWrite.ArtifactMetadata, undefined);
        assert.equal(projectWrite.CodeContent, 'File write test successful.\n');

        // 2. write_to_file inside artifact dir
        const artifactWrite = sanitizeToolCallArgs('write_to_file', {
            TargetFile: '/home/developer/.gemini/antigravity-cli/brain/c8b0596a/walkthrough.md',
            CodeContent: '# Walkthrough',
            Description: 'Summary walkthrough',
            Overwrite: 'true'
        });

        assert.equal(artifactWrite.Overwrite, true);
        assert.ok(artifactWrite.ArtifactMetadata);
        assert.equal(artifactWrite.ArtifactMetadata.Summary, 'Summary walkthrough');
        assert.equal(artifactWrite.ArtifactMetadata.UserFacing, false);

        // 3. view_file string numbers coercion
        const viewCall = sanitizeToolCallArgs('view_file', {
            AbsolutePath: '/workspace/test.txt',
            StartLine: '1',
            EndLine: '25',
            ContentOffset: '0'
        });
        assert.equal(viewCall.StartLine, 1);
        assert.equal(viewCall.EndLine, 25);
        assert.equal(viewCall.ContentOffset, 0);

        // 4. run_command string boolean & number coercion (case-insensitive "False", "True")
        const cmdCall = sanitizeToolCallArgs('run_command', {
            CommandLine: 'ls -la',
            WaitMsBeforeAsync: '1000',
            IsDaemon: 'False',
            RunPersistent: 'True'
        });
        assert.equal(cmdCall.WaitMsBeforeAsync, 1000);
        assert.equal(cmdCall.IsDaemon, false);
        assert.equal(cmdCall.RunPersistent, true);

        // 5. Repository path containing /brain/ in project workspace (must NOT be treated as artifact)
        const repoBrainCall = sanitizeToolCallArgs('write_to_file', {
            TargetFile: '/workspace/robotics/brain/planner.ts',
            CodeContent: 'export const plan = true;',
            ArtifactMetadata: { Summary: 'bad' }
        });
        assert.equal(repoBrainCall.TargetFile, '/workspace/robotics/brain/planner.ts');
        assert.equal(repoBrainCall.ArtifactMetadata, undefined);

        // 6. JSON-stringified ArtifactMetadata on real artifact path is parsed cleanly
        const stringMetaCall = sanitizeToolCallArgs('write_to_file', {
            TargetFile: '/home/developer/.gemini/antigravity-cli/brain/convo-123/notes.md',
            ArtifactMetadata: JSON.stringify({ Summary: 'Parsed summary', UserFacing: true, RequestFeedback: false })
        });
        assert.deepEqual(stringMetaCall.ArtifactMetadata, {
            Summary: 'Parsed summary',
            UserFacing: true,
            RequestFeedback: false
        });
    });

    await t.test('extractResponseValue extracts error and errorMessage from responses', () => {
        const respWithError = { error: 'invalid tool call error: permission denied' };
        assert.equal(extractResponseValue(respWithError, respWithError), 'Error: invalid tool call error: permission denied');

        const partWithMsg = { errorMessage: 'failed to read file: no such file or directory' };
        assert.equal(extractResponseValue({}, partWithMsg), 'Error: failed to read file: no such file or directory');
    });

    await t.test('extractResponseValue handles protobuf { fields: {} } and structValue fallback to parts', () => {
        // 1. resp.parts fallback when response is empty protobuf Struct { fields: {} }
        const respProtoFields = {
            response: { fields: {} },
            parts: [{ text: 'recovered from resp.parts' }]
        };
        assert.equal(extractResponseValue(respProtoFields, respProtoFields), 'recovered from resp.parts');

        // 2. part.parts fallback when resp.response is { fields: {} }
        const partWithParts = {
            functionResponse: { response: { fields: {} } },
            parts: ['recovered from part.parts']
        };
        assert.equal(extractResponseValue(partWithParts.functionResponse, partWithParts), 'recovered from part.parts');

        // 3. resp.response.parts fallback
        const respNestedParts = {
            response: {
                fields: {},
                parts: [{ text: 'recovered from response.parts' }]
            }
        };
        assert.equal(extractResponseValue(respNestedParts, respNestedParts), 'recovered from response.parts');

        // 4. part.functionResponse.parts fallback
        const fnRespParts = {
            functionResponse: {
                response: { fields: {} },
                parts: [{ text: 'recovered from functionResponse.parts' }]
            }
        };
        assert.equal(extractResponseValue(fnRespParts.functionResponse, fnRespParts), 'recovered from functionResponse.parts');

        // 5. { structValue: {} } fallback
        const respStructVal = {
            response: { structValue: {} },
            parts: [{ text: 'recovered from structValue' }]
        };
        assert.equal(extractResponseValue(respStructVal, respStructVal), 'recovered from structValue');

        // 6. { fields: {} } with no parts returns {}
        const respEmptyFieldsOnly = {
            response: { fields: {} }
        };
        assert.deepEqual(extractResponseValue(respEmptyFieldsOnly, respEmptyFieldsOnly), {});

        // 7. isEffectivelyEmpty handles empty shapes and '{ }' with whitespace
        assert.equal(isEffectivelyEmpty(null), true);
        assert.equal(isEffectivelyEmpty(undefined), true);
        assert.equal(isEffectivelyEmpty(''), true);
        assert.equal(isEffectivelyEmpty('   '), true);
        assert.equal(isEffectivelyEmpty('{}'), true);
        assert.equal(isEffectivelyEmpty('{ }'), true);
        assert.equal(isEffectivelyEmpty('  {   }  '), true);
        assert.equal(isEffectivelyEmpty({}), true);
        assert.equal(isEffectivelyEmpty({ fields: {} }), true);
        assert.equal(isEffectivelyEmpty({ structValue: {} }), true);
        assert.equal(isEffectivelyEmpty('{"a": 1}'), false);
        assert.equal(isEffectivelyEmpty({ fields: { a: 1 } }), false);
    });

    await t.test('extractResponseValue unpacks strings from output, result, content, or text', () => {
        assert.equal(extractResponseValue({ response: { output: 'unpacked output' } }), 'unpacked output');
        assert.equal(extractResponseValue({ response: { result: 'unpacked result' } }), 'unpacked result');
        assert.equal(extractResponseValue({ response: { content: 'unpacked content' } }), 'unpacked content');
        assert.equal(extractResponseValue({ response: { text: 'unpacked text' } }), 'unpacked text');

        // Extraction from candParts with various formats
        const candPartsResp = {
            response: { fields: {} },
            parts: [
                { output: 'cand output' },
                { result: 'cand result' },
                { content: 'cand content' },
                { data: { text: 'cand data text' } }
            ]
        };
        assert.equal(
            extractResponseValue(candPartsResp, candPartsResp),
            'cand output\ncand result\ncand content\ncand data text'
        );
    });

    await t.test('extractResponseValue inspects all error fields across sources', () => {
        // Error inside resp.response.error
        const nestedRespErr = {
            response: {
                error: 'status 7: file already exists'
            }
        };
        assert.equal(extractResponseValue(nestedRespErr, nestedRespErr), 'Error: status 7: file already exists');

        // Error inside part.functionResponse.error_details
        const fnRespErr = {
            functionResponse: {
                error_details: 'permission check failed'
            }
        };
        assert.equal(extractResponseValue({}, fnRespErr), 'Error: permission check failed');

        // Error inside val itself
        assert.equal(extractResponseValue({ response: { errorDetails: 'access denied' } }), 'Error: access denied');

        // Combined output and error
        const outputWithErr = {
            response: {
                output: 'some partial output',
                error: 'operation timed out'
            }
        };
        assert.equal(extractResponseValue(outputWithErr, outputWithErr), 'some partial output\nError: operation timed out');
    });

    await t.test('getFunctionResponse extracts call ID with fallback to part', () => {
        const partWithIdOnPart = {
            id: 'call_fallback_part_123',
            functionResponse: {
                name: 'write_to_file',
                response: { output: 'success' }
            }
        };
        const fnResp1 = getFunctionResponse(partWithIdOnPart);
        assert.ok(fnResp1);
        assert.equal(fnResp1.id, 'call_fallback_part_123');
        assert.equal(fnResp1.name, 'write_to_file');
        assert.equal(fnResp1.response, 'success');

        const partWithCallIdOnPart = {
            call_id: 'call_fallback_part_456',
            functionResponse: {
                name: 'run_command',
                response: { output: 'echo done' }
            }
        };
        const fnResp2 = getFunctionResponse(partWithCallIdOnPart);
        assert.ok(fnResp2);
        assert.equal(fnResp2.id, 'call_fallback_part_456');

        const partWithRespId = {
            id: 'part_id_ignored',
            functionResponse: {
                name: 'run_command',
                id: 'resp_id_preferred',
                response: { output: 'done' }
            }
        };
        const fnResp3 = getFunctionResponse(partWithRespId);
        assert.ok(fnResp3);
        assert.equal(fnResp3.id, 'resp_id_preferred');
    });

    await t.test('unpackProtobufValue recursively unwraps protobuf Struct and Value wrappers', () => {
        // Primitives
        assert.equal(unpackProtobufValue({ stringValue: 'hello world' }), 'hello world');
        assert.equal(unpackProtobufValue({ numberValue: 42 }), 42);
        assert.equal(unpackProtobufValue({ boolValue: true }), true);
        assert.equal(unpackProtobufValue({ nullValue: null }), null);

        // List value
        assert.deepEqual(
            unpackProtobufValue({ listValue: { values: [{ stringValue: 'first' }, { numberValue: 2 }] } }),
            ['first', 2]
        );

        // Struct value with fields
        const pbStruct = {
            fields: {
                output: { stringValue: 'Created file /workspace/file.txt with requested content.' },
                exitCode: { numberValue: 0 },
                success: { boolValue: true }
            }
        };
        assert.deepEqual(unpackProtobufValue(pbStruct), {
            output: 'Created file /workspace/file.txt with requested content.',
            exitCode: 0,
            success: true
        });

        // Nested structValue
        const nestedStruct = {
            structValue: {
                fields: {
                    nestedKey: { stringValue: 'nestedVal' }
                }
            }
        };
        assert.deepEqual(unpackProtobufValue(nestedStruct), {
            nestedKey: 'nestedVal'
        });

        // Pass-through for standard primitives
        assert.equal(unpackProtobufValue('plain string'), 'plain string');
        assert.equal(unpackProtobufValue(123), 123);
        assert.equal(unpackProtobufValue(null), null);
    });

    await t.test('formatToolSuccessFallback returns descriptive confirmation strings', () => {
        assert.equal(formatToolSuccessFallback('write_to_file'), 'File written successfully.');
        assert.equal(formatToolSuccessFallback('Write_To_File'), 'File written successfully.');
        assert.equal(formatToolSuccessFallback('replace_file_content'), 'File content updated successfully.');
        assert.equal(formatToolSuccessFallback('edit_file'), 'File content updated successfully.');
        assert.equal(formatToolSuccessFallback('save_memory'), 'Memory recorded successfully.');
        assert.equal(formatToolSuccessFallback('lookup_memory'), 'No matching memories found.');
        assert.equal(formatToolSuccessFallback('manage_subagents'), 'Subagent operation completed successfully.');
        assert.equal(formatToolSuccessFallback('notify_the_user'), 'Notification sent successfully.');
        assert.equal(formatToolSuccessFallback('read_url_content'), 'Web page content is empty.');
        assert.equal(formatToolSuccessFallback('view_file'), 'File read completed.');
        assert.equal(formatToolSuccessFallback('list_dir'), 'Directory listing completed.');
        assert.equal(formatToolSuccessFallback('grep_search'), 'Search completed.');
        assert.equal(formatToolSuccessFallback('run_command'), 'Command executed.');
        assert.equal(formatToolSuccessFallback('custom_tool'), 'Tool executed successfully with no additional output.');
        assert.equal(formatToolSuccessFallback(''), 'Tool executed successfully with no additional output.');
        assert.equal(formatToolSuccessFallback(null), 'Tool executed successfully with no additional output.');
    });

    await t.test('extractResponseValue unpacks protobuf Struct { fields: ... } from response', () => {
        // Wire format from agy protobuf struct: { response: { fields: { output: { stringValue: '...' } } } }
        const respFromWire = {
            name: 'write_to_file',
            response: {
                fields: {
                    output: {
                        stringValue: 'Created file file:///workspace/test.txt with requested content.'
                    }
                }
            }
        };
        assert.equal(
            extractResponseValue(respFromWire, respFromWire),
            'Created file file:///workspace/test.txt with requested content.'
        );

        // With result field
        const respWithResult = {
            name: 'run_command',
            response: {
                fields: {
                    result: {
                        stringValue: 'test command execution output'
                    }
                }
            }
        };
        assert.equal(
            extractResponseValue(respWithResult, respWithResult),
            'test command execution output'
        );
    });

    await t.test('extractResponseValue decodes base64 FunctionResponseBlob inside parts data', () => {
        const testText = 'Created file file:///workspace/llm-plays-pokemon/test.txt with requested content.';
        const base64Data = Buffer.from(testText, 'utf8').toString('base64');
        const respWithBlob = {
            name: 'write_to_file',
            response: { fields: {} },
            parts: [
                {
                    data: {
                        mimeType: 'text/plain',
                        data: base64Data
                    }
                }
            ]
        };
        assert.equal(extractResponseValue(respWithBlob, respWithBlob), testText);

        // RetrievalResult in parts
        const respWithRetrieval = {
            name: 'search_docs',
            response: {},
            parts: [
                {
                    retrievalResult: {
                        content: 'Documentation page content here'
                    }
                }
            ]
        };
        assert.equal(extractResponseValue(respWithRetrieval, respWithRetrieval), 'Documentation page content here');
    });

    await t.test('extractResponseValue uses tool-specific fallback when response is empty', () => {
        const respEmpty = { response: { fields: {} } };
        assert.equal(extractResponseValue(respEmpty, respEmpty, 'write_to_file'), 'File written successfully.');
        assert.equal(extractResponseValue(respEmpty, respEmpty, 'manage_subagents'), 'Subagent operation completed successfully.');
        // If no tool name is provided, retains backwards compatibility returning {}
        assert.deepEqual(extractResponseValue(respEmpty, respEmpty), {});
    });

    await t.test('getFunctionResponse preserves empty response as {} so callers can bind sibling text or fallback', () => {
        const partEmpty = {
            functionResponse: {
                name: 'write_to_file',
                id: 'call_w1',
                response: {}
            }
        };
        const fnResp = getFunctionResponse(partEmpty);
        assert.ok(fnResp);
        assert.equal(fnResp.name, 'write_to_file');
        assert.deepEqual(fnResp.response, {});
    });

    await t.test('prepareToolResponses binds unconsumed sibling text and falls back correctly', () => {
        const partsWithSibling = [
            { functionResponse: { name: 'write_to_file', id: 'c1', response: {} } },
            { text: 'File written to disk' }
        ];
        const res1 = prepareToolResponses(partsWithSibling);
        assert.equal(res1.consumedParts.size, 1);
        const boundResp = res1.fnRespMap.get(partsWithSibling[0]);
        assert.ok(boundResp);
        assert.equal(boundResp.response, 'File written to disk');

        const partsWithoutSibling = [
            { functionResponse: { name: 'write_to_file', id: 'c2', response: {} } }
        ];
        const res2 = prepareToolResponses(partsWithoutSibling);
        assert.equal(res2.consumedParts.size, 0);
        const fallbackResp = res2.fnRespMap.get(partsWithoutSibling[0]);
        assert.ok(fallbackResp);
        assert.equal(fallbackResp.response, 'File written successfully.');
    });

    await t.test('geminiContentsToAnthropic binds sibling text parts to empty tool responses', () => {
        const contents = [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'write_to_file',
                            id: 'call_write_1',
                            args: { TargetFile: '/workspace/test.txt', CodeContent: 'hello' }
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'write_to_file',
                            id: 'call_write_1',
                            response: {}
                        }
                    },
                    {
                        text: 'Created file file:///workspace/test.txt with requested content.'
                    }
                ]
            }
        ];

        const { messages } = geminiContentsToAnthropic(contents);
        assert.equal(messages.length, 3); // Prepends Proceed. user turn, assistant tool_use, user tool_result
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[1].role, 'assistant');
        assert.equal(messages[2].role, 'user');

        // Verify tool_result contains the sibling text rather than {}
        const toolResult = messages[2].content.find(c => c.type === 'tool_result');
        assert.ok(toolResult);
        assert.equal(toolResult.tool_use_id, 'call_write_1');
        assert.equal(toolResult.content, 'Created file file:///workspace/test.txt with requested content.');

        // Sibling text must NOT be emitted as a separate redundant text block
        const separateText = messages[2].content.filter(c => c.type === 'text');
        assert.equal(separateText.length, 0, 'Sibling text part must be consumed by tool_result and not duplicated');
    });

    await t.test('geminiContentsToAnthropic falls back to descriptive confirmation when tool response is empty with no sibling text', () => {
        const contents = [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'write_to_file',
                            id: 'call_write_2',
                            args: { TargetFile: '/workspace/test2.txt' }
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'write_to_file',
                            id: 'call_write_2',
                            response: {}
                        }
                    }
                ]
            }
        ];

        const { messages } = geminiContentsToAnthropic(contents);
        const toolResult = messages[messages.length - 1].content.find(c => c.type === 'tool_result');
        assert.ok(toolResult);
        assert.equal(toolResult.content, 'File written successfully.');
    });


    await t.test('geminiContentsToOpenAI binds sibling text parts to empty tool responses', () => {
        const contents = [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'write_to_file',
                            id: 'call_oai_1',
                            args: { TargetFile: '/workspace/oai.txt' }
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'write_to_file',
                            id: 'call_oai_1',
                            response: {}
                        }
                    },
                    {
                        text: 'Created file file:///workspace/oai.txt with requested content.'
                    }
                ]
            }
        ];

        const messages = geminiContentsToOpenAI(contents);
        const toolMsg = messages.find(m => m.role === 'tool');
        assert.ok(toolMsg);
        assert.equal(toolMsg.tool_call_id, 'call_oai_1');
        assert.equal(toolMsg.content, 'Created file file:///workspace/oai.txt with requested content.');

        // No trailing user message duplicating the text
        const userMsgs = messages.filter(m => m.role === 'user');
        assert.equal(userMsgs.length, 0, 'Sibling text must not be duplicated into user messages');
    });

    await t.test('geminiContentsToOpenAI falls back to descriptive confirmation when tool response is empty with no sibling text', () => {
        const contents = [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'manage_subagents',
                            id: 'call_subagent_1',
                            args: { Action: 'list' }
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'manage_subagents',
                            id: 'call_subagent_1',
                            response: {}
                        }
                    }
                ]
            }
        ];

        const messages = geminiContentsToOpenAI(contents);
        const toolMsg = messages.find(m => m.role === 'tool');
        assert.ok(toolMsg);
        assert.equal(toolMsg.content, 'Subagent operation completed successfully.');
    });

    await t.test('geminiContentsToOpenAI converts user turn with tool execution text following functionCall into role: tool', () => {
        const contents = [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'run_command',
                            id: 'call_cmd_1',
                            args: { CommandLine: 'ls -l' }
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        text: 'Created At: 2026-09-13T01:52:07Z\nCompleted At: 2026-09-13T01:52:08Z\n\nThe command exited with code 0.\nOutput:\nfile1.txt\n'
                    }
                ]
            }
        ];

        const messages = geminiContentsToOpenAI(contents);
        const toolMsg = messages.find(m => m.role === 'tool');
        assert.ok(toolMsg, 'Expected a role: tool message for the tool execution text');
        assert.equal(toolMsg.tool_call_id, 'call_cmd_1');
        assert.ok(toolMsg.content.includes('The command exited with code 0.'));

        // Verify it was not duplicated into an accompanying user message
        const userMsgs = messages.filter(m => m.role === 'user');
        assert.equal(userMsgs.length, 0, 'Tool output must not remain as a user message');
    });

    await t.test('geminiContentsToAnthropic converts user turn with tool execution text following functionCall into tool_result', () => {
        const contents = [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'write_to_file',
                            id: 'call_w_1',
                            args: { TargetFile: '/workspace/test.txt', CodeContent: 'abc' }
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        text: 'Created At: 2026-09-13T01:52:00Z\nCompleted At: 2026-09-13T01:52:00Z\nCreated file file:///workspace/test.txt with requested content.'
                    }
                ]
            }
        ];

        const { messages } = geminiContentsToAnthropic(contents);
        const userTurn = messages[messages.length - 1];
        assert.equal(userTurn.role, 'user');
        const toolResult = userTurn.content.find(c => c.type === 'tool_result');
        assert.ok(toolResult, 'Expected tool_result content block');
        assert.equal(toolResult.tool_use_id, 'call_w_1');
        assert.ok(toolResult.content.includes('Created file file:///workspace/test.txt with requested content.'));
    });

    await t.test('geminiContentsToOpenAI hydrates tool response via toolOutputs or falls back safely', () => {
        const contents = [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'write_to_file',
                            id: 'call_lookahead_1',
                            args: { TargetFile: '/workspace/lookahead.txt' }
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'write_to_file',
                            id: 'call_lookahead_1',
                            response: {}
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        text: 'Next user turn text'
                    }
                ]
            }
        ];

        // 1. Without toolOutputs, fallback is used and subsequent user message is preserved
        const messagesNoOutputs = geminiContentsToOpenAI(contents);
        const toolMsgNoOutputs = messagesNoOutputs.find(m => m.role === 'tool');
        assert.ok(toolMsgNoOutputs);
        assert.equal(toolMsgNoOutputs.tool_call_id, 'call_lookahead_1');
        assert.equal(toolMsgNoOutputs.content, 'File written successfully.');
        const userMsg = messagesNoOutputs.find(m => m.role === 'user');
        assert.ok(userMsg);
        assert.equal(userMsg.content, 'Next user turn text');

        // 2. With toolOutputs, exact authentic content is hydrated
        const toolOutputs = {
            outputsByCallId: new Map([
                ['call_lookahead_1', 'Created file file:///workspace/lookahead.txt with requested content.']
            ])
        };
        const messagesHydrated = geminiContentsToOpenAI(contents, null, { toolOutputs });
        const toolMsgHydrated = messagesHydrated.find(m => m.role === 'tool');
        assert.ok(toolMsgHydrated);
        assert.equal(toolMsgHydrated.tool_call_id, 'call_lookahead_1');
        assert.equal(toolMsgHydrated.content, 'Created file file:///workspace/lookahead.txt with requested content.');
    });

    await t.test('chatMessagesToResponsesInput binds user turn with tool execution output to function_call_output', () => {
        const messages = [
            {
                role: 'assistant',
                content: 'Running command',
                tool_calls: [{ id: 'call_resp_1', function: { name: 'run_command', arguments: '{"CommandLine":"ls"}' } }]
            },
            {
                role: 'user',
                content: 'Created At: 2026-09-13T01:52:07Z\nCompleted At: 2026-09-13T01:52:08Z\n\nThe command exited with code 0.\nOutput:\nfoo.txt'
            }
        ];

        const input = chatMessagesToResponsesInput(messages);
        const fnOutput = input.find(item => item.type === 'function_call_output');
        assert.ok(fnOutput, 'Expected function_call_output');
        assert.equal(fnOutput.call_id, 'call_resp_1');
        assert.ok(fnOutput.output.includes('The command exited with code 0.'));
        assert.notEqual(fnOutput.output, '{}');
    });

    await t.test('isToolExecutionOutput accurately distinguishes tool execution output from user prompts', () => {
        assert.equal(isToolExecutionOutput('Created At: 2026-09-13T01:52:00Z\nOutput:\nok'), true);
        assert.equal(isToolExecutionOutput('The command exited with code 0.'), true);
        assert.equal(isToolExecutionOutput('Created file file:///workspace/test.txt with requested content.'), true);
        assert.equal(isToolExecutionOutput('You have 4 active subagent(s): [...]'), true);
        assert.equal(isToolExecutionOutput('Message sent to "agent-123".'), true);
        assert.equal(isToolExecutionOutput('Error: permission check failed: user denied permission'), true);
        assert.equal(isToolExecutionOutput('Command failed with exit code 1'), true);
        assert.equal(isToolExecutionOutput('<USER_REQUEST>Please run ls</USER_REQUEST>'), false);
        assert.equal(isToolExecutionOutput('<SYSTEM_MESSAGE>[Notice] restart</SYSTEM_MESSAGE>'), false);
        assert.equal(isToolExecutionOutput('Second prompt'), false);
        assert.equal(isToolExecutionOutput('How are you today?'), false);
    });

    await t.test('chatMessagesToResponsesInput handles array content blocks and matches call ID out-of-order', () => {
        const messages = [
            {
                role: 'assistant',
                content: 'Running commands',
                tool_calls: [
                    { id: 'call_cmd_A', function: { name: 'run_command', arguments: '{"CommandLine":"ls"}' } },
                    { id: 'call_cmd_B', function: { name: 'view_file', arguments: '{"AbsolutePath":"/a.txt"}' } }
                ]
            },
            {
                role: 'user',
                tool_call_id: 'call_cmd_B',
                content: [
                    { type: 'text', text: 'Created At: 2026-09-13T01:52:00Z\nOutput:\nfile content B' }
                ]
            },
            {
                role: 'user',
                tool_call_id: 'call_cmd_A',
                content: 'Created At: 2026-09-13T01:52:01Z\nOutput:\ncommand output A'
            }
        ];

        const input = chatMessagesToResponsesInput(messages);
        const outA = input.find(item => item.type === 'function_call_output' && item.call_id === 'call_cmd_A');
        const outB = input.find(item => item.type === 'function_call_output' && item.call_id === 'call_cmd_B');
        assert.ok(outA);
        assert.ok(outB);
        assert.ok(outA.output.includes('command output A'));
        assert.ok(outB.output.includes('file content B'));
    });

    await t.test('prepareToolResponses does not leak lookahead across user turn boundaries', () => {
        const contents = [
            {
                role: 'model',
                parts: [
                    { functionCall: { name: 'run_command', id: 'c_leak', args: { CommandLine: 'pwd' } } }
                ]
            },
            {
                role: 'user',
                parts: [
                    { functionResponse: { name: 'run_command', id: 'c_leak', response: {} } }
                ]
            },
            {
                role: 'user',
                parts: [
                    { text: '<USER_REQUEST>What is the current time?</USER_REQUEST>' }
                ]
            }
        ];

        const messages = geminiContentsToOpenAI(contents);
        const toolMsg = messages.find(m => m.role === 'tool');
        assert.ok(toolMsg);
        // Function fallback used, user prompt NOT consumed as tool output
        assert.equal(toolMsg.content, 'Command executed.');
        const userMsg = messages.find(m => m.role === 'user');
        assert.ok(userMsg);
        assert.equal(userMsg.content, '<USER_REQUEST>What is the current time?</USER_REQUEST>');
    });

    await t.test('createToolOutputResolver resolves by callId first, then FIFO by toolName', () => {
        const outputsByCallId = new Map([
            ['call_123', 'output from call_123']
        ]);
        const outputsByToolName = new Map([
            ['view_file', ['file content 1', 'file content 2']]
        ]);
        const resolver = createToolOutputResolver({ outputsByCallId, outputsByToolName });

        // Match by callId
        assert.equal(resolver('call_123', 'view_file'), 'output from call_123');

        // Match by toolName FIFO
        assert.equal(resolver('unknown_call', 'view_file'), 'file content 1');
        assert.equal(resolver(null, 'view_file'), 'file content 2');
        assert.equal(resolver('unknown_call', 'view_file'), null);
    });

    await t.test('resolveConversationToolOutputs parses conversation trajectory and DB hermetically', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoder-test-'));
        try {
            const convoId = 'test-convo-123';
            const convoBrainDir = path.join(tmpDir, 'brain', convoId);
            const logsDir = path.join(convoBrainDir, '.system_generated', 'logs');
            const stepDir = path.join(convoBrainDir, '.system_generated', 'steps', '2');
            fs.mkdirSync(logsDir, { recursive: true });
            fs.mkdirSync(stepDir, { recursive: true });

            // Create step 2 output.txt
            fs.writeFileSync(path.join(stepDir, 'output.txt'), 'Disk file content from step 2\n');

            // Create transcript.jsonl
            const lines = [
                JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hello' }),
                JSON.stringify({
                    step_index: 1,
                    type: 'PLANNER_RESPONSE',
                    tool_calls: [{ name: 'run_command', id: 'call_cmd_hermetic' }]
                }),
                JSON.stringify({
                    step_index: 2,
                    type: 'STEP_TYPE_TOOL_OUTPUT',
                    content: 'Transcript fallback output'
                })
            ];
            fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), lines.join('\n'));

            // Create conversations SQLite DB with protobuf metadata
            const convosDir = path.join(tmpDir, 'conversations');
            fs.mkdirSync(convosDir, { recursive: true });
            const dbPath = path.join(convosDir, `${convoId}.db`);
            const { Database } = require('bun:sqlite');
            const db = new Database(dbPath);
            db.run('CREATE TABLE steps (idx INTEGER, step_type INTEGER, metadata BLOB)');

            // Construct protobuf-like metadata buffer: call_cmd_hermetic + 0x12 + length + "run_command"
            const callId = 'call_cmd_hermetic';
            const toolName = 'run_command';
            const metaBuf = Buffer.concat([
                Buffer.from(callId),
                Buffer.from([0x12, toolName.length]),
                Buffer.from(toolName)
            ]);
            db.query('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(2, 132, metaBuf);
            db.close();

            const res = resolveConversationToolOutputs(convoId, null, tmpDir);
            assert.ok(res);
            assert.equal(res.targetConvoId, convoId);
            assert.ok(res.outputsByCallId.has('call_cmd_hermetic'));
            assert.equal(res.outputsByCallId.get('call_cmd_hermetic'), 'Disk file content from step 2\n');
            assert.ok(res.outputsByToolName.has('run_command'));
            assert.deepEqual(res.outputsByToolName.get('run_command'), ['Disk file content from step 2\n']);

            // Verify unknown convo returns null targetConvoId and does not cross-pollute
            const emptyRes = resolveConversationToolOutputs('unknown-convo-id', null, tmpDir);
            assert.equal(emptyRes.targetConvoId, null);
            assert.equal(emptyRes.outputsByCallId.size, 0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await t.test('geminiContentsToOpenAI preserves target tool name when tool output is effectively empty', () => {
        const contents = [
            {
                role: 'model',
                parts: [
                    { functionCall: { name: 'write_to_file', id: 'call_write_empty', args: {} } }
                ]
            },
            {
                role: 'user',
                call_id: 'call_write_empty',
                parts: [
                    { text: '   ' } // effectively empty whitespace
                ]
            }
        ];

        const messages = geminiContentsToOpenAI(contents);
        const toolMsg = messages.find(m => m.role === 'tool');
        assert.ok(toolMsg);
        assert.equal(toolMsg.content, 'File written successfully.');
    });

    await t.test('geminiContentsToAnthropic guarantees tool_result follows every tool_use even across consecutive model turns and empty responses', () => {
        const contents = [
            {
                role: 'user',
                parts: [{ text: 'Please execute step 1' }]
            },
            {
                role: 'model',
                parts: [{
                    functionCall: {
                        name: 'run_command',
                        id: 'toolu_multi_1',
                        args: { CommandLine: 'cat test.txt' }
                    }
                }]
            },
            // Note: Consecutive model turn without intervening user tool response!
            {
                role: 'model',
                parts: [{
                    text: 'Now let me write the file'
                }, {
                    functionCall: {
                        name: 'write_to_file',
                        id: 'toolu_multi_2',
                        args: { TargetFile: '/workspace/test.txt' }
                    }
                }]
            },
            // User turn with empty response
            {
                role: 'user',
                parts: [{
                    functionResponse: {
                        name: 'write_to_file',
                        id: 'toolu_multi_2',
                        response: {}
                    }
                }]
            }
        ];

        const { messages } = geminiContentsToAnthropic(contents);

        // Verify strict alternating sequence
        for (let i = 0; i < messages.length; i++) {
            const expectedRole = i % 2 === 0 ? 'user' : 'assistant';
            assert.equal(messages[i].role, expectedRole, `Message at index ${i} must have role ${expectedRole}`);
        }

        // Verify tool_use at message 1 is immediately followed by tool_result in message 2
        const assistant1 = messages[1];
        const toolUse1 = assistant1.content.find(c => c.type === 'tool_use');
        assert.ok(toolUse1, 'Assistant 1 must contain tool_use');
        assert.equal(toolUse1.id, 'toolu_multi_1');

        const user1 = messages[2];
        assert.equal(user1.role, 'user');
        const toolResult1 = user1.content.find(c => c.type === 'tool_result');
        assert.ok(toolResult1, 'User 1 must contain tool_result for toolu_multi_1');
        assert.equal(toolResult1.tool_use_id, 'toolu_multi_1');
        assert.notEqual(toolResult1.content, '{}', 'tool_result must never be empty {}');
        assert.ok(toolResult1.content.includes('Command executed') || toolResult1.content.includes('executed successfully'));

        // Verify tool_use at message 3 is immediately followed by tool_result in message 4
        const assistant2 = messages[3];
        const toolUse2 = assistant2.content.find(c => c.type === 'tool_use');
        assert.ok(toolUse2, 'Assistant 2 must contain tool_use');
        assert.equal(toolUse2.id, 'toolu_multi_2');

        const user2 = messages[4];
        assert.equal(user2.role, 'user');
        const toolResult2 = user2.content.find(c => c.type === 'tool_result');
        assert.ok(toolResult2, 'User 2 must contain tool_result for toolu_multi_2');
        assert.equal(toolResult2.tool_use_id, 'toolu_multi_2');
        assert.equal(toolResult2.content, 'File written successfully.');
    });

    await t.test('resolveConversationToolOutputs auto-discovers conversation via candidateIds or latest directory when convoId is missing', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-autodiscover-test-'));
        try {
            const convoOld = 'convo-old-111';
            const convoNew = 'convo-new-222';

            const brainOld = path.join(tmpDir, 'brain', convoOld);
            const brainNew = path.join(tmpDir, 'brain', convoNew);
            fs.mkdirSync(brainOld, { recursive: true });
            fs.mkdirSync(brainNew, { recursive: true });

            // Ensure brainNew has later mtime
            const now = Date.now();
            fs.utimesSync(brainOld, (now - 5000) / 1000, (now - 5000) / 1000);
            fs.utimesSync(brainNew, now / 1000, now / 1000);

            // Test 1: Auto-discover via candidateIds
            const resCandidates = resolveConversationToolOutputs(null, null, tmpDir, {
                candidateIds: [convoOld]
            });
            assert.equal(resCandidates.targetConvoId, convoOld);

            // Test 2: Fall back to latest brain directory when candidateIds is empty
            const resLatest = resolveConversationToolOutputs(null, null, tmpDir, {});
            assert.equal(resLatest.targetConvoId, convoNew);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await t.test('geminiContentsToAnthropic flushes all sibling pending calls in same user turn when receiving synthetic tool output', () => {
        const contents = [
            {
                role: 'user',
                parts: [{ text: 'Please execute both commands.' }]
            },
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            id: 'toolu_cmd_1',
                            name: 'run_command',
                            args: { CommandLine: 'echo 1' }
                        }
                    },
                    {
                        functionCall: {
                            id: 'toolu_cmd_2',
                            name: 'view_file',
                            args: { AbsolutePath: '/workspace/file.txt' }
                        }
                    }
                ]
            },
            // Next turn is synthetic text output for the first command
            {
                role: 'model',
                id: 'toolu_cmd_1',
                parts: [{ text: 'Tool call output: Command exited with code 0. 1' }]
            }
        ];

        const { messages } = geminiContentsToAnthropic(contents, null);
        // messages[0] = user
        // messages[1] = assistant with 2 tool_use blocks
        // messages[2] = user with 2 tool_result blocks!
        assert.equal(messages.length, 3);
        assert.equal(messages[1].role, 'assistant');
        assert.equal(messages[1].content.filter(c => c.type === 'tool_use').length, 2);

        assert.equal(messages[2].role, 'user');
        assert.equal(messages[2].content.length, 2);
        assert.equal(messages[2].content[0].type, 'tool_result');
        assert.equal(messages[2].content[0].tool_use_id, 'toolu_cmd_1');
        assert.ok(messages[2].content[0].content.includes('Command exited with code 0'));

        assert.equal(messages[2].content[1].type, 'tool_result');
        assert.equal(messages[2].content[1].tool_use_id, 'toolu_cmd_2');
        assert.ok(messages[2].content[1].content.includes('File read completed.'));
    });

    await t.test('geminiContentsToOpenAI flushes all sibling pending calls immediately when receiving synthetic tool output', () => {
        const contents = [
            {
                role: 'user',
                parts: [{ text: 'Execute commands' }]
            },
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            id: 'call_cmd_1',
                            name: 'run_command',
                            args: { CommandLine: 'pwd' }
                        }
                    },
                    {
                        functionCall: {
                            id: 'call_cmd_2',
                            name: 'view_file',
                            args: { AbsolutePath: '/workspace/test.txt' }
                        }
                    }
                ]
            },
            {
                role: 'model',
                id: 'call_cmd_1',
                parts: [{ text: 'Tool call output: /workspace' }]
            }
        ];

        const messages = geminiContentsToOpenAI(contents, null);
        // messages[0] = user
        // messages[1] = assistant with 2 tool_calls
        // messages[2] = tool for call_cmd_1
        // messages[3] = tool for call_cmd_2
        assert.equal(messages.length, 4);
        assert.equal(messages[1].role, 'assistant');
        assert.equal(messages[1].tool_calls.length, 2);

        assert.equal(messages[2].role, 'tool');
        assert.equal(messages[2].tool_call_id, 'call_cmd_1');
        assert.ok(messages[2].content.includes('/workspace'));

        assert.equal(messages[3].role, 'tool');
        assert.equal(messages[3].tool_call_id, 'call_cmd_2');
        assert.ok(messages[3].content.includes('File read completed.'));
    });

    await t.test('geminiContentsToAnthropic does not mutate original parts text when media is present', () => {
        const originalText = 'Tool execution output for toolu_media_1: success';
        const contents = [
            {
                role: 'user',
                parts: [{
                    functionResponse: {
                        name: 'generate_image',
                        id: 'toolu_media_1',
                        response: {}
                    }
                }]
            },
            {
                role: 'user',
                parts: [
                    { text: originalText },
                    { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } }
                ]
            }
        ];

        geminiContentsToAnthropic(contents, null);
        assert.equal(contents[1].parts[0].text, originalText, 'Must not mutate original parts text in place');
    });

    await t.test('resolveConversationToolOutputs prioritizes matching call IDs over candidateIds when multiple conversations exist', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-multi-convo-test-'));
        try {
            const convoStale = 'convo-stale-prev';
            const convoActive = 'convo-active-current';

            const brainStale = path.join(tmpDir, 'brain', convoStale);
            const brainActive = path.join(tmpDir, 'brain', convoActive);
            fs.mkdirSync(brainStale, { recursive: true });
            fs.mkdirSync(brainActive, { recursive: true });

            // Create step output in active convo
            const stepDir = path.join(brainActive, '.system_generated', 'steps', '2');
            fs.mkdirSync(stepDir, { recursive: true });
            fs.writeFileSync(path.join(stepDir, 'output.txt'), 'Directory listing: /workspace\n');

            // Record step in active convo SQLite DB
            const convosDir = path.join(tmpDir, 'conversations');
            fs.mkdirSync(convosDir, { recursive: true });
            const dbPath = path.join(convosDir, `${convoActive}.db`);

            const Database = require('bun:sqlite').Database;
            const db = new Database(dbPath);
            db.query('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)').run();

            const targetCallId = 'call_ls_workspace_99';
            const toolName = 'run_command';
            const metaBuf = Buffer.concat([
                Buffer.from(targetCallId),
                Buffer.from([0x12, toolName.length]),
                Buffer.from(toolName)
            ]);
            db.query('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(2, 132, metaBuf);
            db.close();

            // Candidate IDs has convoStale as first element (e.g. from previous session)
            const result = resolveConversationToolOutputs(null, null, tmpDir, {
                candidateIds: [convoStale],
                callIds: [targetCallId]
            });

            // Must NOT pick convoStale; must match convoActive via callId
            assert.equal(result.targetConvoId, convoActive);
            assert.ok(result.outputsByCallId.has(targetCallId));
            assert.equal(result.outputsByCallId.get(targetCallId), 'Directory listing: /workspace\n');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await t.test('resolveConversationToolOutputs sorts candidates by transcript activity mtime', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mtime-convo-test-'));
        try {
            const convo1 = 'convo-one';
            const convo2 = 'convo-two';

            const brain1 = path.join(tmpDir, 'brain', convo1);
            const brain2 = path.join(tmpDir, 'brain', convo2);
            fs.mkdirSync(brain1, { recursive: true });
            fs.mkdirSync(brain2, { recursive: true });

            // Create transcripts with different timestamps
            const logs1 = path.join(brain1, '.system_generated', 'logs');
            const logs2 = path.join(brain2, '.system_generated', 'logs');
            fs.mkdirSync(logs1, { recursive: true });
            fs.mkdirSync(logs2, { recursive: true });

            const tFile1 = path.join(logs1, 'transcript.jsonl');
            const tFile2 = path.join(logs2, 'transcript.jsonl');
            fs.writeFileSync(tFile1, '{"step_index":0}\n');
            fs.writeFileSync(tFile2, '{"step_index":0}\n');

            const now = Date.now();
            fs.utimesSync(tFile1, (now - 10000) / 1000, (now - 10000) / 1000);
            fs.utimesSync(tFile2, now / 1000, now / 1000);

            // Pass both as candidate IDs in reverse order
            const result = resolveConversationToolOutputs(null, null, tmpDir, {
                candidateIds: [convo1, convo2]
            });

            // convo2 was modified more recently, so it should win
            assert.equal(result.targetConvoId, convo2);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await t.test('resolveConversationToolOutputs matches multi-turn SQLite tool calls on step 2 or later', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-multiturn-sqlite-test-'));
        try {
            const convoId = 'convo-multiturn-123';
            const brainDir = path.join(tmpDir, 'brain', convoId);
            fs.mkdirSync(path.join(brainDir, '.system_generated', 'steps', '4'), { recursive: true });
            fs.writeFileSync(path.join(brainDir, '.system_generated', 'steps', '4', 'output.txt'), 'step 4 output content\n');

            const convosDir = path.join(tmpDir, 'conversations');
            fs.mkdirSync(convosDir, { recursive: true });
            const dbPath = path.join(convosDir, `${convoId}.db`);

            const Database = require('bun:sqlite').Database;
            const db = new Database(dbPath);
            db.query('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)').run();

            // Turn 1
            const call1 = 'call_step1_turn1';
            const meta1 = Buffer.concat([Buffer.from(call1), Buffer.from([0x12, 11]), Buffer.from('run_command')]);
            db.query('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(2, 132, meta1);

            // Turn 2
            const call2 = 'call_step2_turn2';
            const meta2 = Buffer.concat([Buffer.from(call2), Buffer.from([0x12, 11]), Buffer.from('run_command')]);
            db.query('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(4, 132, meta2);
            db.close();

            const result = resolveConversationToolOutputs(null, null, tmpDir, {
                candidateIds: [convoId],
                callIds: [call2]
            });

            assert.equal(result.targetConvoId, convoId);
            assert.ok(result.outputsByCallId.has(call2));
            assert.equal(result.outputsByCallId.get(call2), 'step 4 output content\n');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});


