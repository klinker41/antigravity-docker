#!/usr/bin/env node

const http = require('node:http');
const crypto = require('node:crypto');
const url = require('node:url');
const fs = require('node:fs');

const LISTEN_PORT = parseInt(process.env.AGY_PORT || '4400', 10);
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const PORT_FILE = process.env.PORT_FILE || '/tmp/antigravity_port';
let TARGET_PORT = parseInt(process.env.INITIAL_TARGET_PORT || '0', 10);

// Generate expected auth token from password
function getExpectedToken() {
    if (!AUTH_PASSWORD) return '';
    return crypto.createHash('sha256').update(`antigravity_salt_${AUTH_PASSWORD}`).digest('hex');
}

const EXPECTED_TOKEN = getExpectedToken();

// Parse cookies helper
function parseCookies(req) {
    const list = {};
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return list;

    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (!name) return;
        const value = rest.join('=').trim();
        list[name] = decodeURIComponent(value);
    });
    return list;
}

// Check if request is authenticated
function isAuthenticated(req) {
    if (!AUTH_PASSWORD) return true; // No password configured -> open access
    const cookies = parseCookies(req);
    return cookies['antigravity_session'] === EXPECTED_TOKEN;
}

// Modern Google Antigravity Dark Theme Login Page HTML
function renderLoginPage(error = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Google Antigravity Remote Access</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400;500;600;700&family=Google+Sans+Code:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #08090d;
            --card-bg: rgba(14, 18, 27, 0.75);
            --card-border: rgba(255, 255, 255, 0.1);
            --card-border-glow: rgba(66, 133, 244, 0.3);
            --accent-blue: #1a73e8;
            --accent-blue-hover: #1557b0;
            --accent-blue-glow: #4285f4;
            --accent-cyan: #38bdf8;
            --text-primary: #f0f4fc;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            --input-bg: rgba(9, 12, 18, 0.7);
            --input-border: rgba(255, 255, 255, 0.12);
            --error-bg: rgba(239, 68, 68, 0.12);
            --error-border: rgba(239, 68, 68, 0.35);
            --error-text: #fca5a5;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: "Google Sans Flex", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        body {
            background-color: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            position: relative;
            padding: 20px;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }

        /* Ambient glowing nebula background effects */
        .ambient-glow {
            position: absolute;
            border-radius: 50%;
            filter: blur(120px);
            pointer-events: none;
            opacity: 0.55;
            z-index: 1;
            animation: pulseGlow 14s ease-in-out infinite alternate;
        }

        .ambient-glow-1 {
            width: 500px;
            height: 500px;
            background: radial-gradient(circle, rgba(26, 115, 232, 0.35) 0%, rgba(26, 115, 232, 0) 70%);
            top: -100px;
            left: -100px;
        }

        .ambient-glow-2 {
            width: 550px;
            height: 550px;
            background: radial-gradient(circle, rgba(124, 58, 237, 0.28) 0%, rgba(124, 58, 237, 0) 70%);
            bottom: -120px;
            right: -120px;
            animation-duration: 18s;
        }

        .ambient-glow-3 {
            width: 380px;
            height: 380px;
            background: radial-gradient(circle, rgba(56, 189, 248, 0.22) 0%, rgba(56, 189, 248, 0) 70%);
            top: 45%;
            left: 60%;
            animation-duration: 12s;
        }

        @keyframes pulseGlow {
            0% { transform: scale(1) translate(0, 0); opacity: 0.45; }
            50% { transform: scale(1.15) translate(20px, -20px); opacity: 0.65; }
            100% { transform: scale(0.95) translate(-15px, 15px); opacity: 0.5; }
        }

        /* Particle Canvas */
        #antigravity-canvas {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 2;
            pointer-events: auto;
        }

        /* Main Login Card */
        .login-wrapper {
            position: relative;
            z-index: 10;
            width: 100%;
            max-width: 420px;
        }

        .login-card {
            background: var(--card-bg);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid var(--card-border);
            border-radius: 20px;
            padding: 36px 32px;
            box-shadow:
                0 30px 70px rgba(0, 0, 0, 0.7),
                0 0 45px rgba(26, 115, 232, 0.12),
                inset 0 1px 0 rgba(255, 255, 255, 0.15);
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        .login-card:hover {
            border-color: var(--card-border-glow);
            box-shadow:
                0 35px 80px rgba(0, 0, 0, 0.75),
                0 0 55px rgba(66, 133, 244, 0.18),
                inset 0 1px 0 rgba(255, 255, 255, 0.2);
        }

        /* Header & Branding */
        .brand-header {
            text-align: center;
            margin-bottom: 28px;
        }

        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px;
            border-radius: 9999px;
            background: rgba(34, 197, 94, 0.1);
            border: 1px solid rgba(34, 197, 94, 0.25);
            font-size: 11px;
            font-weight: 500;
            color: #86efac;
            margin-bottom: 16px;
            letter-spacing: 0.3px;
            text-transform: uppercase;
        }

        .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: #22c55e;
            box-shadow: 0 0 8px #22c55e;
            animation: statusBlink 2s infinite;
        }

        @keyframes statusBlink {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.85); }
        }

        .logo-container {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 60px;
            height: 60px;
            background: linear-gradient(135deg, rgba(26, 115, 232, 0.2), rgba(56, 189, 248, 0.1));
            border: 1px solid rgba(66, 133, 244, 0.35);
            border-radius: 16px;
            margin-bottom: 16px;
            box-shadow: 0 8px 24px rgba(26, 115, 232, 0.25);
            position: relative;
            overflow: hidden;
        }

        .logo-container::after {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: linear-gradient(60deg, transparent, rgba(255, 255, 255, 0.15), transparent);
            transform: rotate(30deg);
            animation: logoShine 6s infinite ease-in-out;
        }

        @keyframes logoShine {
            0%, 75% { transform: rotate(30deg) translateY(-100%); }
            100% { transform: rotate(30deg) translateY(100%); }
        }

        .logo-svg {
            width: 32px;
            height: 32px;
            filter: drop-shadow(0 2px 8px rgba(66, 133, 244, 0.5));
        }

        h1 {
            font-size: 22px;
            font-weight: 600;
            letter-spacing: -0.3px;
            color: #ffffff;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }

        p.subtitle {
            font-size: 13.5px;
            color: var(--text-secondary);
            line-height: 1.4;
        }

        /* Error Banner */
        .error-banner {
            display: flex;
            align-items: center;
            gap: 10px;
            background: var(--error-bg);
            border: 1px solid var(--error-border);
            color: var(--error-text);
            padding: 11px 14px;
            border-radius: 10px;
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 20px;
            animation: shake 0.45s ease-in-out;
        }

        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            20%, 60% { transform: translateX(-6px); }
            40%, 80% { transform: translateX(6px); }
        }

        .error-icon {
            flex-shrink: 0;
            width: 16px;
            height: 16px;
        }

        /* Form */
        .form-group {
            margin-bottom: 22px;
        }

        .label-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        label {
            font-size: 13px;
            font-weight: 500;
            color: #cbd5e1;
            letter-spacing: 0.1px;
        }

        .input-container {
            position: relative;
            display: flex;
            align-items: center;
        }

        .input-icon {
            position: absolute;
            left: 14px;
            width: 17px;
            height: 17px;
            color: var(--text-muted);
            pointer-events: none;
            transition: color 0.2s ease;
        }

        input[type="password"],
        input[type="text"] {
            width: 100%;
            padding: 12px 42px 12px 40px;
            background: var(--input-bg);
            border: 1px solid var(--input-border);
            border-radius: 10px;
            color: #ffffff;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
            font-family: inherit;
        }

        input:focus {
            background: rgba(12, 16, 25, 0.9);
            border-color: var(--accent-blue-glow);
            box-shadow:
                0 0 0 3px rgba(66, 133, 244, 0.25),
                0 0 16px rgba(66, 133, 244, 0.15);
        }

        input:focus + .input-icon,
        .input-container:focus-within .input-icon {
            color: var(--accent-blue-glow);
        }

        .toggle-password {
            position: absolute;
            right: 12px;
            background: none;
            border: none;
            color: var(--text-muted);
            cursor: pointer;
            padding: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 6px;
            transition: color 0.2s, background-color 0.2s;
        }

        .toggle-password:hover {
            color: var(--text-primary);
            background: rgba(255, 255, 255, 0.06);
        }

        /* Submit Button */
        button[type="submit"] {
            width: 100%;
            padding: 13px 20px;
            background: linear-gradient(135deg, #1a73e8 0%, #3b82f6 100%);
            color: #ffffff;
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 10px;
            font-size: 14.5px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 4px 18px rgba(26, 115, 232, 0.35);
        }

        button[type="submit"]:hover {
            background: linear-gradient(135deg, #1967d2 0%, #2563eb 100%);
            box-shadow: 0 6px 24px rgba(26, 115, 232, 0.5);
            transform: translateY(-1.5px);
        }

        button[type="submit"]:active {
            transform: translateY(0);
            box-shadow: 0 2px 10px rgba(26, 115, 232, 0.3);
        }

        .btn-icon {
            width: 16px;
            height: 16px;
            transition: transform 0.2s ease;
        }

        button[type="submit"]:hover .btn-icon {
            transform: translateX(2px);
        }

        /* Footer */
        .card-footer {
            margin-top: 24px;
            text-align: center;
            border-top: 1px solid rgba(255, 255, 255, 0.06);
            padding-top: 18px;
        }

        .card-footer p {
            font-size: 12px;
            color: var(--text-muted);
            letter-spacing: 0.2px;
        }

        .card-footer code {
            font-family: "Google Sans Code", monospace;
            background: rgba(255, 255, 255, 0.05);
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 11px;
            color: #cbd5e1;
        }

        @media (max-width: 480px) {
            .login-card {
                padding: 28px 22px;
                border-radius: 16px;
            }
            h1 {
                font-size: 20px;
            }
        }
    </style>
</head>
<body>
    <!-- Ambient Nebulae -->
    <div class="ambient-glow ambient-glow-1"></div>
    <div class="ambient-glow ambient-glow-2"></div>
    <div class="ambient-glow ambient-glow-3"></div>

    <!-- Antigravity Interactive Particle Canvas -->
    <canvas id="antigravity-canvas"></canvas>

    <div class="login-wrapper">
        <div class="login-card">
            <div class="brand-header">
                <div class="status-pill">
                    <span class="status-dot"></span>
                    <span>Gateway Secured</span>
                </div>
                <div>
                    <div class="logo-container">
                        <!-- Antigravity Liftoff Vector Logo -->
                        <svg class="logo-svg" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M18 3L23.5 12.5H12.5L18 3Z" fill="url(#brand-grad)" />
                            <path d="M18 12L27 27.5H9L18 12Z" fill="url(#brand-grad-2)" opacity="0.9" />
                            <circle cx="18" cy="20" r="3.5" fill="#ffffff" />
                            <defs>
                                <linearGradient id="brand-grad" x1="12.5" y1="3" x2="23.5" y2="12.5" gradientUnits="userSpaceOnUse">
                                    <stop stop-color="#38bdf8" />
                                    <stop offset="1" stop-color="#1a73e8" />
                                </linearGradient>
                                <linearGradient id="brand-grad-2" x1="9" y1="12" x2="27" y2="27.5" gradientUnits="userSpaceOnUse">
                                    <stop stop-color="#4285f4" />
                                    <stop offset="1" stop-color="#a78bfa" />
                                </linearGradient>
                            </defs>
                        </svg>
                    </div>
                </div>
                <h1>Google Antigravity</h1>
                <p class="subtitle">Enter access password to unlock remote session</p>
            </div>

            ${error ? `
            <div class="error-banner">
                <svg class="error-icon" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                </svg>
                <span>${error}</span>
            </div>` : ''}

            <form method="POST" action="/__auth/login">
                <div class="form-group">
                    <div class="label-row">
                        <label for="password">Password</label>
                    </div>
                    <div class="input-container">
                        <svg class="input-icon" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                        </svg>
                        <input type="password" id="password" name="password" required autofocus placeholder="Enter access password..." autocomplete="current-password">
                        <button type="button" class="toggle-password" id="togglePasswordBtn" title="Toggle password visibility" aria-label="Toggle password visibility">
                            <svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                <circle cx="12" cy="12" r="3"></circle>
                            </svg>
                        </button>
                    </div>
                </div>

                <button type="submit" id="submitBtn">
                    <span>Unlock Workspace</span>
                    <svg class="btn-icon" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clip-rule="evenodd" />
                    </svg>
                </button>
            </form>

            <div class="card-footer">
                <p>Protected by <code>Antigravity Gateway</code></p>
            </div>
        </div>
    </div>

    <script>
        // Password Visibility Toggle
        const passwordInput = document.getElementById('password');
        const toggleBtn = document.getElementById('togglePasswordBtn');
        const eyeIcon = document.getElementById('eyeIcon');

        if (toggleBtn && passwordInput) {
            toggleBtn.addEventListener('click', () => {
                const isPassword = passwordInput.type === 'password';
                passwordInput.type = isPassword ? 'text' : 'password';
                eyeIcon.innerHTML = isPassword
                    ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>'
                    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
            });
        }

        // Antigravity Particle Simulation Engine
        (function initAntigravityBackground() {
            const canvas = document.getElementById('antigravity-canvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            let width = 0;
            let height = 0;
            let dpr = window.devicePixelRatio || 1;
            let particles = [];
            let shockwaves = [];
            let animationFrameId = null;

            const mouse = {
                x: -1000,
                y: -1000,
                radius: 150,
                active: false
            };

            const colors = [
                'rgba(138, 180, 248, ',  // Google Soft Blue
                'rgba(66, 133, 244, ',   // Google Blue
                'rgba(56, 189, 248, ',   // Sky Cyan
                'rgba(167, 139, 250, ',  // Gemini Indigo/Purple
                'rgba(255, 255, 255, '   // Pure White Star
            ];

            function resize() {
                width = window.innerWidth;
                height = window.innerHeight;
                dpr = Math.min(window.devicePixelRatio || 1, 2);

                canvas.width = width * dpr;
                canvas.height = height * dpr;
                ctx.scale(dpr, dpr);

                initParticles();
            }

            class Particle {
                constructor() {
                    this.reset(true);
                }

                reset(initial = false) {
                    this.x = Math.random() * width;
                    this.y = initial ? Math.random() * height : height + Math.random() * 20;
                    // Upward anti-gravity drift bias
                    this.baseVx = (Math.random() - 0.5) * 0.4;
                    this.baseVy = -(Math.random() * 0.45 + 0.2);
                    this.vx = this.baseVx;
                    this.vy = this.baseVy;
                    this.radius = Math.random() * 1.8 + 0.8;
                    this.baseAlpha = Math.random() * 0.55 + 0.2;
                    this.alpha = this.baseAlpha;
                    this.colorBase = colors[Math.floor(Math.random() * colors.length)];
                    this.pulseSpeed = Math.random() * 0.02 + 0.008;
                    this.pulsePhase = Math.random() * Math.PI * 2;
                }

                update() {
                    this.pulsePhase += this.pulseSpeed;
                    this.alpha = this.baseAlpha + Math.sin(this.pulsePhase) * 0.15;

                    // Apply anti-gravity mouse repulsion / deflection
                    if (mouse.active) {
                        const dx = this.x - mouse.x;
                        const dy = this.y - mouse.y;
                        const dist = Math.sqrt(dx * dx + dy * dy);

                        if (dist < mouse.radius && dist > 0) {
                            const force = (1 - dist / mouse.radius) * 1.6;
                            const angle = Math.atan2(dy, dx);
                            this.vx += Math.cos(angle) * force * 0.4;
                            this.vy += Math.sin(angle) * force * 0.4;
                        }
                    }

                    // Apply shockwave physics
                    for (const sw of shockwaves) {
                        const dx = this.x - sw.x;
                        const dy = this.y - sw.y;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        const diff = Math.abs(dist - sw.radius);

                        if (diff < 35 && dist > 0) {
                            const force = (1 - diff / 35) * sw.strength * 0.35;
                            const angle = Math.atan2(dy, dx);
                            this.vx += Math.cos(angle) * force;
                            this.vy += Math.sin(angle) * force;
                        }
                    }

                    // Drag / return to base upward velocity
                    this.vx += (this.baseVx - this.vx) * 0.04;
                    this.vy += (this.baseVy - this.vy) * 0.04;

                    this.x += this.vx;
                    this.y += this.vy;

                    // Wrap boundaries
                    if (this.y < -20) this.reset(false);
                    if (this.x < -20) this.x = width + 20;
                    if (this.x > width + 20) this.x = -20;
                }

                draw() {
                    ctx.beginPath();
                    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                    ctx.fillStyle = this.colorBase + Math.max(0.05, Math.min(1, this.alpha)) + ')';
                    ctx.fill();
                }
            }

            function initParticles() {
                const count = Math.min(95, Math.max(45, Math.floor((width * height) / 14000)));
                particles = [];
                for (let i = 0; i < count; i++) {
                    particles.push(new Particle());
                }
            }

            // Interactive event listeners
            window.addEventListener('mousemove', (e) => {
                mouse.x = e.clientX;
                mouse.y = e.clientY;
                mouse.active = true;
            }, { passive: true });

            window.addEventListener('mouseleave', () => {
                mouse.active = false;
            });

            window.addEventListener('touchstart', (e) => {
                if (e.touches.length > 0) {
                    mouse.x = e.touches[0].clientX;
                    mouse.y = e.touches[0].clientY;
                    mouse.active = true;
                }
            }, { passive: true });

            window.addEventListener('touchmove', (e) => {
                if (e.touches.length > 0) {
                    mouse.x = e.touches[0].clientX;
                    mouse.y = e.touches[0].clientY;
                    mouse.active = true;
                }
            }, { passive: true });

            window.addEventListener('touchend', () => {
                mouse.active = false;
            });

            // Click shockwave ripple
            window.addEventListener('pointerdown', (e) => {
                shockwaves.push({
                    x: e.clientX,
                    y: e.clientY,
                    radius: 5,
                    maxRadius: 180,
                    speed: 4.5,
                    strength: 3.5,
                    alpha: 0.6
                });
            });

            function render() {
                ctx.clearRect(0, 0, width, height);

                // Update & draw shockwaves
                for (let i = shockwaves.length - 1; i >= 0; i--) {
                    const sw = shockwaves[i];
                    sw.radius += sw.speed;
                    sw.alpha *= 0.94;

                    ctx.beginPath();
                    ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
                    ctx.strokeStyle = 'rgba(138, 180, 248, ' + (sw.alpha * 0.35) + ')';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();

                    if (sw.radius > sw.maxRadius || sw.alpha < 0.02) {
                        shockwaves.splice(i, 1);
                    }
                }

                // Connect particles within constellation range
                const connectionDist = 110;
                for (let i = 0; i < particles.length; i++) {
                    const p1 = particles[i];
                    p1.update();
                    p1.draw();

                    for (let j = i + 1; j < particles.length; j++) {
                        const p2 = particles[j];
                        const dx = p1.x - p2.x;
                        const dy = p1.y - p2.y;
                        const dist = Math.sqrt(dx * dx + dy * dy);

                        if (dist < connectionDist) {
                            const lineAlpha = (1 - dist / connectionDist) * 0.22 * Math.min(p1.alpha, p2.alpha);
                            ctx.beginPath();
                            ctx.moveTo(p1.x, p1.y);
                            ctx.lineTo(p2.x, p2.y);
                            ctx.strokeStyle = 'rgba(138, 180, 248, ' + lineAlpha + ')';
                            ctx.lineWidth = 0.8;
                            ctx.stroke();
                        }
                    }
                }

                animationFrameId = requestAnimationFrame(render);
            }

            window.addEventListener('resize', resize);
            resize();

            // Check reduced motion preference
            const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (!prefersReducedMotion) {
                render();
            } else {
                // Static render for accessibility
                particles.forEach(p => p.draw());
            }

            // Conserve CPU when tab is inactive
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    if (animationFrameId) cancelAnimationFrame(animationFrameId);
                } else if (!prefersReducedMotion) {
                    render();
                }
            });
        })();
    </script>
</body>
</html>`;
}

// Modern 503 Starting Up Page HTML
function renderStartingPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="3">
    <title>Starting Google Antigravity...</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: "Google Sans Flex", -apple-system, BlinkMacSystemFont, sans-serif; }
        body {
            background-color: #08090d;
            color: #f0f4fc;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            text-align: center;
        }
        .card {
            background: rgba(14, 18, 27, 0.8);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            padding: 40px 32px;
            max-width: 440px;
            width: 100%;
            backdrop-filter: blur(20px);
            box-shadow: 0 30px 70px rgba(0, 0, 0, 0.7), 0 0 45px rgba(26, 115, 232, 0.15);
        }
        .spinner {
            width: 48px;
            height: 48px;
            border: 3px solid rgba(66, 133, 244, 0.2);
            border-top: 3px solid #38bdf8;
            border-right: 3px solid #1a73e8;
            border-radius: 50%;
            margin: 0 auto 24px;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        h2 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #ffffff; }
        p { font-size: 14px; color: #94a3b8; line-height: 1.5; }
        .meta { margin-top: 20px; font-size: 12px; color: #64748b; }
    </style>
</head>
<body>
    <div class="card">
        <div class="spinner"></div>
        <h2>Antigravity Server Starting Up...</h2>
        <p>Initializing agent workspace and secure remote control tunnels. This page will automatically refresh.</p>
        <div class="meta">Auto-refreshing every 3 seconds</div>
    </div>
</body>
</html>`;
}

// Create HTTP Proxy Server
const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Handle Login POST
    if (parsedUrl.pathname === '/__auth/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            const params = new URLSearchParams(body);
            const enteredPassword = params.get('password') || '';

            if (enteredPassword === AUTH_PASSWORD) {
                // Set 30-day persistent cookie
                res.writeHead(302, {
                    'Set-Cookie': `antigravity_session=${EXPECTED_TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
                    'Location': '/'
                });
                res.end();
            } else {
                res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderLoginPage('Incorrect password. Please try again.'));
            }
        });
        return;
    }

    // Check authentication
    if (!isAuthenticated(req)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderLoginPage());
        return;
    }

    // If target port is not ready yet
    if (!TARGET_PORT) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderStartingPage());
        return;
    }

    // Proxy HTTP Request with Host/Origin/Referer rewrite to localhost
    const proxyHeaders = { ...req.headers };
    proxyHeaders['host'] = `localhost:${TARGET_PORT}`;
    proxyHeaders['origin'] = `http://localhost:${TARGET_PORT}`;
    if (proxyHeaders['referer']) {
        proxyHeaders['referer'] = proxyHeaders['referer'].replace(/^https?:\/\/[^\/]+/, `http://localhost:${TARGET_PORT}`);
    }

    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: TARGET_PORT,
        path: req.url,
        method: req.method,
        headers: proxyHeaders,
    }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error('[HTTP Proxy Error]', err.message);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Antigravity upstream server unavailable.');
        }
    });

    req.pipe(proxyReq, { end: true });
});

// Handle WebSocket / Upgrade requests using standard HTTP upgrade negotiation
server.on('upgrade', (req, clientSocket, head) => {
    if (!isAuthenticated(req)) {
        clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        clientSocket.destroy();
        return;
    }

    if (!TARGET_PORT) {
        clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        clientSocket.destroy();
        return;
    }

    const proxyHeaders = { ...req.headers };
    proxyHeaders['host'] = `localhost:${TARGET_PORT}`;
    proxyHeaders['origin'] = `http://localhost:${TARGET_PORT}`;
    if (proxyHeaders['referer']) {
        proxyHeaders['referer'] = proxyHeaders['referer'].replace(/^https?:\/\/[^\/]+/, `http://localhost:${TARGET_PORT}`);
    }

    const upstreamReq = http.request({
        hostname: '127.0.0.1',
        port: TARGET_PORT,
        path: req.url,
        method: req.method,
        headers: proxyHeaders,
    });

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
        let rawResponse = `HTTP/1.1 101 Switching Protocols\r\n`;
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (Array.isArray(value)) {
                for (const v of value) rawResponse += `${key}: ${v}\r\n`;
            } else {
                rawResponse += `${key}: ${value}\r\n`;
            }
        }
        rawResponse += '\r\n';

        clientSocket.write(rawResponse);
        if (upstreamHead && upstreamHead.length > 0) clientSocket.write(upstreamHead);
        if (head && head.length > 0) upstreamSocket.write(head);

        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);

        upstreamSocket.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstreamSocket.destroy());
    });

    upstreamReq.on('error', (err) => {
        console.error('[WebSocket Upgrade Error]', err.message);
        clientSocket.destroy();
    });

    upstreamReq.end();
});

// Update dynamic target port
function setTargetPort(port) {
    TARGET_PORT = parseInt(port, 10);
    console.log(`[Proxy Gateway] 🔗 Bridged port ${LISTEN_PORT} -> http://127.0.0.1:${TARGET_PORT}`);
}

// Watch port file for dynamic port detection
function checkPortFile() {
    try {
        if (fs.existsSync(PORT_FILE)) {
            const content = fs.readFileSync(PORT_FILE, 'utf8').trim();
            const port = parseInt(content, 10);
            if (port && port !== TARGET_PORT) {
                setTargetPort(port);
            }
        }
    } catch (e) {}
}

setInterval(checkPortFile, 500);
checkPortFile();

server.listen(LISTEN_PORT, '0.0.0.0', () => {
    console.log(`[Proxy Gateway] 🛡️  Listening on 0.0.0.0:${LISTEN_PORT} (Password Protection: ${AUTH_PASSWORD ? 'ENABLED' : 'DISABLED'})`);
});
