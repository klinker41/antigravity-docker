'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderModelsPage } = require('../proxy/lib/pages.js');

test('renderModelsPage - Responsive Layout & Modal Configuration', async (t) => {
    const html = renderModelsPage();

    await t.test('renders valid HTML document structure', () => {
        assert.ok(html.startsWith('<!DOCTYPE html>'));
        assert.ok(html.includes('External Providers & Models'));
        assert.ok(html.includes('id="addProviderBtn"'));
        assert.ok(html.includes('id="providerModal"'));
    });

    await t.test('has mobile responsive CSS rules', () => {
        // Contains media queries for mobile viewports
        assert.ok(html.includes('@media (max-width: 600px)'));
        assert.ok(html.includes('.models-header'));
        assert.ok(html.includes('.custom-model-row'));
        assert.ok(html.includes('.provider-header'));
        assert.ok(html.includes('.modal-footer-actions'));

        // Header stacks vertically on mobile
        assert.ok(html.includes('flex-direction: column'));
        // Modal overlay and box adapt on mobile
        assert.ok(html.includes('.modal-overlay {'));
        assert.ok(html.includes('.modal-box {'));
    });

    await t.test('modal overlay supports both active and show classes', () => {
        assert.ok(html.includes('.modal-overlay.active'));
        assert.ok(html.includes('.modal-overlay.show'));
        // Modal open/close logic properly manages classes
        assert.ok(html.includes("modal.classList.add('active')"));
        assert.ok(html.includes("modal.classList.remove('active')"));
        assert.ok(html.includes("modal.classList.add('show')"));
        assert.ok(html.includes("modal.classList.remove('show')"));
        // Clicking backdrop closes modal
        assert.ok(html.includes('e.target === modal'));
    });

    await t.test('outdated Anthropic model examples are removed', () => {
        // No outdated Claude model versions
        assert.ok(!html.includes('Claude 3.5/3.7'));
        assert.ok(!html.includes('claude-3-7-sonnet-20250219'));
        assert.ok(!html.includes('Anthropic Claude'));

        // Generic and up-to-date phrasing in place
        assert.ok(html.includes('placeholder="Model ID"'));
        assert.ok(html.includes('placeholder="e.g. Anthropic, OpenAI, Local Ollama"'));
    });

    await t.test('includes provider query and model selection controls', () => {
        // Fetch button and status
        assert.ok(html.includes('id="fetchModelsBtn"'));
        assert.ok(html.includes('Fetch Available Models from Provider'));
        assert.ok(html.includes('id="fetchStatus"'));

        // Available models container and filter
        assert.ok(html.includes('id="modelsSectionTitle"'));
        assert.ok(html.includes('id="modelsQuickActions"'));
        assert.ok(html.includes('id="selectAllModels"'));
        assert.ok(html.includes('id="deselectAllModels"'));
        assert.ok(html.includes('id="modelFilterInput"'));
        assert.ok(html.includes('id="modelsContainer"'));

        // Collapsible manual model entry
        assert.ok(html.includes('id="toggleManualModelBtn"'));
        assert.ok(html.includes('id="manualModelRow"'));
        assert.ok(html.includes('id="addCustomModelBtn"'));

        // Thinking capability controls
        assert.ok(html.includes('id="customModelThinking"'));
        assert.ok(html.includes('toggleModelThinking'));
        // UI uses provider-provided metadata; no hardcoded model regex in client HTML
        assert.equal(html.includes('isThinkingModel'), false);

        // Vision capability controls
        assert.ok(html.includes('id="customModelVision"'));
        assert.ok(html.includes('toggleModelVision'));
        assert.ok(html.includes('Vision'));
    });
});

