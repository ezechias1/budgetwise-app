import { supabase } from './supabase-config.js';

// Particle background
(function() {
    var canvas = document.getElementById('bgCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var particles = [];

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    for (var i = 0; i < 40; i++) {
        particles.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            vx: (Math.random() - 0.5) * 0.3,
            vy: (Math.random() - 0.5) * 0.3,
            size: Math.random() * 1.5 + 0.5,
            opacity: Math.random() * 0.2 + 0.03
        });
    }

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (var i = 0; i < particles.length; i++) {
            var p = particles[i];
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0) p.x = canvas.width;
            if (p.x > canvas.width) p.x = 0;
            if (p.y < 0) p.y = canvas.height;
            if (p.y > canvas.height) p.y = 0;

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            var pc = window._particleColor || '16,185,129';
            ctx.fillStyle = 'rgba(' + pc + ',' + p.opacity + ')';
            ctx.fill();

            for (var j = i + 1; j < particles.length; j++) {
                var p2 = particles[j];
                var d = Math.sqrt((p.x - p2.x) ** 2 + (p.y - p2.y) ** 2);
                if (d < 100) {
                    ctx.beginPath();
                    ctx.moveTo(p.x, p.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.strokeStyle = 'rgba(' + pc + ',' + (0.04 * (1 - d / 100)) + ')';
                    ctx.stroke();
                }
            }
        }
        requestAnimationFrame(animate);
    }
    animate();
})();

// Tab switching
var tabs = document.querySelectorAll('.tab-btn');
var loginForm = document.getElementById('loginForm');
var signupForm = document.getElementById('signupForm');
var forgotForm = document.getElementById('forgotForm');

tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
        tabs.forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        // Clear errors on tab switch
        document.getElementById('loginError').textContent = '';
        document.getElementById('signupError').textContent = '';
        document.getElementById('signupError').style.color = '';
        document.getElementById('forgotError').textContent = '';
        forgotForm.classList.add('hidden');
        if (tab.dataset.tab === 'login') {
            loginForm.classList.remove('hidden');
            signupForm.classList.add('hidden');
        } else {
            signupForm.classList.remove('hidden');
            loginForm.classList.add('hidden');
        }
    });
});

// Account type toggle
var selectedAccountType = 'personal';
document.getElementById('accountTypeToggle').addEventListener('click', function(e) {
    var btn = e.target.closest('.type-btn');
    if (!btn || btn.classList.contains('active')) return;
    document.querySelectorAll('.type-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    selectedAccountType = btn.dataset.type;

    // Update page theme colors based on account type
    var root = document.body.style;
    if (selectedAccountType === 'business') {
        root.setProperty('--accent', '#3b82f6');
        root.setProperty('--accent-dark', '#2563eb');
        root.setProperty('--accent-alt', '#60a5fa');
        root.setProperty('--accent-shadow', 'rgba(59, 130, 246, 0.3)');
        root.setProperty('--accent-glow', 'rgba(59, 130, 246, 0.15)');
        window._particleColor = '59,130,246';
    } else if (selectedAccountType === 'family') {
        root.setProperty('--accent', '#8b5cf6');
        root.setProperty('--accent-dark', '#7c3aed');
        root.setProperty('--accent-alt', '#a78bfa');
        root.setProperty('--accent-shadow', 'rgba(139, 92, 246, 0.3)');
        root.setProperty('--accent-glow', 'rgba(139, 92, 246, 0.15)');
        window._particleColor = '139,92,246';
    } else {
        root.setProperty('--accent', '#10b981');
        root.setProperty('--accent-dark', '#059669');
        root.setProperty('--accent-alt', '#06b6d4');
        root.setProperty('--accent-shadow', 'rgba(16, 185, 129, 0.3)');
        root.setProperty('--accent-glow', 'rgba(16, 185, 129, 0.15)');
        window._particleColor = '16,185,129';
    }

    var companyField = document.getElementById('companyField');
    var companyInput = document.getElementById('signupCompany');
    var familyNameField = document.getElementById('familyNameField');
    var familyNameInput = document.getElementById('signupFamilyName');
    var typeDesc = document.getElementById('typeDesc');
    var emailLabel = document.querySelector('#signupEmail').closest('.field').querySelector('label');
    var emailInput = document.getElementById('signupEmail');

    // Update description
    var descriptions = {
        personal: 'Track your personal spending, savings, and goals.',
        business: 'Manage expenses, invoices, clients, and tax reports.',
        family: 'Budget together, track allowances, and set shared goals.'
    };
    if (typeDesc) typeDesc.textContent = descriptions[selectedAccountType];

    // Update email field label based on account type
    if (selectedAccountType === 'business') {
        emailLabel.textContent = 'Business Email';
        emailInput.placeholder = 'yourbusiness@gmail.com';
    } else {
        emailLabel.textContent = 'Email';
        emailInput.placeholder = 'you@example.com';
    }

    if (selectedAccountType === 'business') {
        companyField.classList.remove('hidden');
        companyInput.required = true;
        familyNameField.classList.add('hidden');
        familyNameInput.required = false;
    } else if (selectedAccountType === 'family') {
        familyNameField.classList.remove('hidden');
        familyNameInput.required = true;
        companyField.classList.add('hidden');
        companyInput.required = false;
    } else {
        companyField.classList.add('hidden');
        companyInput.required = false;
        familyNameField.classList.add('hidden');
        familyNameInput.required = false;
    }
});

// Password visibility toggles
document.querySelectorAll('.toggle-pw').forEach(function(btn) {
    btn.addEventListener('click', function() {
        var input = document.getElementById(btn.dataset.target);
        if (input.type === 'password') {
            input.type = 'text';
            btn.classList.add('showing');
        } else {
            input.type = 'password';
            btn.classList.remove('showing');
        }
    });
});

// Forgot password flow
document.getElementById('forgotPasswordLink').addEventListener('click', function(e) {
    e.preventDefault();
    loginForm.classList.add('hidden');
    forgotForm.classList.remove('hidden');
});

document.getElementById('backToLogin').addEventListener('click', function(e) {
    e.preventDefault();
    forgotForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
    document.getElementById('forgotError').textContent = '';
});

forgotForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    var email = document.getElementById('forgotEmail').value;
    var errorEl = document.getElementById('forgotError');
    var btn = forgotForm.querySelector('button[type="submit"]');
    errorEl.textContent = '';
    errorEl.style.color = '';

    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
        var result = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/dashboard.html'
        });
        if (result.error) {
            errorEl.textContent = result.error.message;
        } else {
            errorEl.style.color = '#10b981';
            errorEl.textContent = 'Reset link sent! Check your email inbox.';
        }
    } catch (err) {
        errorEl.textContent = 'Connection error. Please try again.';
    }
    btn.disabled = false;
    btn.textContent = 'Send Reset Link';
});

// Track login event
async function trackLogin(userId) {
    try {
        await supabase.from('login_events').insert({ user_id: userId });
    } catch (e) {}
}

// Listen for auth state changes (handles email verification link click)
supabase.auth.onAuthStateChange(function(event, session) {
    if (event === 'SIGNED_IN' && session) {
        trackLogin(session.user.id);
        sessionStorage.setItem('bw-fresh-login', '1');
        window.location.href = 'dashboard.html';
    }
});

// Check if already logged in
supabase.auth.getSession().then(function(result) {
    if (result.data.session) {
        window.location.href = 'dashboard.html';
    }
}).catch(function() {});

// Email login
loginForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    var email = document.getElementById('loginEmail').value;
    var password = document.getElementById('loginPassword').value;
    var errorEl = document.getElementById('loginError');
    var btn = loginForm.querySelector('button[type="submit"]');
    errorEl.textContent = '';

    btn.disabled = true;
    btn.textContent = 'Logging in...';
    try {
        var result = await supabase.auth.signInWithPassword({ email: email, password: password });
        if (result.error) {
            if (result.error.message === 'Invalid login credentials') {
                errorEl.textContent = 'Incorrect email or password. Don\'t have an account? Sign up first.';
            } else {
                errorEl.textContent = result.error.message;
            }
        } else {
            sessionStorage.setItem('bw-fresh-login', '1');
            window.location.href = 'dashboard.html';
        }
    } catch (err) {
        errorEl.textContent = 'Connection error. Please try again.';
    }
    btn.disabled = false;
    btn.textContent = 'Log In';
});

// Email signup
signupForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    var name = document.getElementById('signupName').value;
    var email = document.getElementById('signupEmail').value;
    var password = document.getElementById('signupPassword').value;
    var errorEl = document.getElementById('signupError');
    var btn = signupForm.querySelector('button[type="submit"]');
    errorEl.textContent = '';
    errorEl.style.color = '';

    btn.disabled = true;
    btn.textContent = 'Creating account...';
    try {
        var company = document.getElementById('signupCompany').value.trim();
        var familyName = document.getElementById('signupFamilyName').value.trim();
        var metadata = { full_name: name, primary_account: selectedAccountType };
        if (selectedAccountType === 'business' && company) {
            metadata.company_name = company;
        }
        if (selectedAccountType === 'family' && familyName) {
            metadata.family_name = familyName;
        }

        var result = await supabase.auth.signUp({
            email: email,
            password: password,
            options: { data: metadata }
        });

        if (result.error) {
            errorEl.textContent = result.error.message;
        } else if (result.data.user && !result.data.session) {
            errorEl.style.color = '#10b981';
            errorEl.textContent = 'Check your email to confirm your account, then log in.';
        } else {
            localStorage.setItem('bw-mode', selectedAccountType);
            localStorage.setItem('bw-primary-account', selectedAccountType);
            if (selectedAccountType === 'business' && company) {
                localStorage.setItem('bw-company', company);
            }
            if (selectedAccountType === 'family' && familyName) {
                localStorage.setItem('bw-family-name', familyName);
            }
            sessionStorage.setItem('bw-fresh-login', '1');
            window.location.href = 'dashboard.html';
        }
    } catch (err) {
        errorEl.textContent = 'Connection error. Please try again.';
    }
    btn.disabled = false;
    btn.textContent = 'Create Account';
});

// Google sign-in
document.getElementById('googleBtn').addEventListener('click', async function() {
    // Show error in whichever tab is active
    var errorEl = loginForm.classList.contains('hidden')
        ? document.getElementById('signupError')
        : document.getElementById('loginError');
    try {
        var result = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin + '/dashboard.html' }
        });
        if (result.error) {
            errorEl.textContent = result.error.message;
        }
    } catch (err) {
        errorEl.textContent = 'Connection error. Please try again.';
    }
});
