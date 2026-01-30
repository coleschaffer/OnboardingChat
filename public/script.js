// CA Pro Onboarding Chat Interface

const STORAGE_KEY = 'ca_pro_onboarding';

// Generate or retrieve session ID
function getSessionId() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        const data = JSON.parse(saved);
        if (data.sessionId) return data.sessionId;
    }
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Load saved progress from localStorage
function loadSavedProgress() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (e) {
            console.error('Error loading saved progress:', e);
        }
    }
    return null;
}

// Save progress to localStorage
function saveLocalProgress() {
    const data = {
        sessionId: state.sessionId,
        currentQuestion: state.currentQuestion,
        answers: state.answers,
        teamMembers: state.teamMembers,
        cLevelPartners: state.cLevelPartners,
        hasTeamMembers: state.hasTeamMembers,
        isComplete: state.isComplete || false
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// State Management
const state = {
    sessionId: getSessionId(),
    currentQuestion: 0,
    answers: {},
    teamMembers: [],
    cLevelPartners: [],
    isTyping: false,
    isSaving: false,
    hasTeamMembers: null,
    isComplete: false
};

// Questions Configuration
const questions = [
    {
        id: 'businessName',
        type: 'text',
        message: "First things first - what's the name of your business?",
        placeholder: "Acme Health Supplements",
        validation: { required: true }
    },
    {
        id: 'teamCount',
        type: 'text',
        message: "How many team members do you currently have?",
        placeholder: "1",
        validation: { required: true }
    },
    {
        id: 'trafficSources',
        type: 'textarea',
        message: "What traffic sources do you typically use to acquire customers?",
        placeholder: "e.g. Facebook Ads, Google Ads, Email...",
        validation: { required: true }
    },
    {
        id: 'landingPages',
        type: 'textarea',
        message: "Please share links to your landing pages, product pages, or any ads/creative assets. The more we see, the better we can help!",
        placeholder: "Paste URLs here...",
        validation: { required: true }
    },
    {
        id: 'massiveWin',
        type: 'textarea',
        message: "What's the #1 thing that, if CA Pro helped you achieve, would be a MASSIVE win for your business?",
        placeholder: "Be specific...",
        validation: { required: true }
    },
    {
        id: 'aiSkillLevel',
        type: 'slider',
        message: "On a scale of 1-10, how would you rate your team's current AI skills when it comes to writing copy, launching funnels, and automating marketing processes?",
        min: 1,
        max: 10,
        defaultValue: 5,
        labels: { left: 'Beginner', right: 'Expert' }
    },
    {
        id: 'teamMembers',
        type: 'teamEntry',
        message: "Let's set up your team access! They'll get access to weekly trainings, the member's area, and all past courses. You can add as many team members as you'd like. Who should be added?",
        fields: ['name', 'email', 'phone'],
        addButtonText: '+ Add Team Member',
        optional: true
    },
    {
        id: 'cLevelPartners',
        type: 'partnerEntry',
        message: "Any C-Level executives or business partners you'd like added to the Business Owner WhatsApp group? They'll get access to owner-level discussions and the member's area.",
        fields: ['name', 'email', 'phone'],
        addButtonText: '+ Add Partner',
        optional: true
    },
    {
        id: 'bio',
        type: 'textarea',
        message: "Share a quick bio about yourself for our member directory. This helps other business owners and their teams get to know you!",
        placeholder: "A few sentences about you...",
        validation: { required: true }
    },
    {
        id: 'scheduleCall',
        type: 'scheduling',
        message: "Want to schedule your first 1:1 call? Pick who would be most helpful for where you're at:",
        options: [
            {
                value: 'stefan',
                name: 'Stefan',
                image: 'stefan-pfp.jpg',
                description: 'Marketing & Scaling — copy reviews, funnel optimization, big picture strategy',
                url: 'https://calendly.com/stefanpaulgeorgi/ca-pro-1-1-with-stefan'
            },
            {
                value: 'angela',
                name: 'Angela',
                image: 'angela-pfp.jpeg',
                description: 'Operations — SOPs, KPIs, hiring, team building, retention, cash flow',
                url: 'https://calendly.com/angela-meetings/ca-pro-1-1-w-angela'
            }
        ],
        optional: true
    },
    {
        id: 'whatsappJoined',
        type: 'buttons',
        message: "Have you joined our WhatsApp community yet? This is where most of the mastermind communication happens!\n\n👉 <a href=\"https://chat.whatsapp.com/KMVMZEWvJadLrVGY672wkM\" target=\"_blank\">Click To Join WhatsApp</a>",
        options: [
            { value: 'done', label: "Yes, I've joined!" },
            { value: 'later', label: "I'll do it later" }
        ]
    }
];

// Save progress to backend (called after each question)
async function saveProgress(isComplete = false) {
    // Always save locally first
    if (isComplete) state.isComplete = true;
    saveLocalProgress();

    if (state.isSaving) return;
    state.isSaving = true;

    try {
        // Add the last question ID to answers for tracking
        const currentQ = questions[state.currentQuestion];
        const answersWithTracking = {
            ...state.answers,
            lastQuestionId: currentQ ? currentQ.id : 'completed'
        };

        const response = await fetch('/api/onboarding/save-progress', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sessionId: state.sessionId,
                answers: answersWithTracking,
                teamMembers: state.teamMembers,
                cLevelPartners: state.cLevelPartners,
                currentQuestion: state.currentQuestion,
                totalQuestions: questions.length,
                isComplete
            })
        });

        if (!response.ok) {
            console.error('Failed to save progress');
        } else {
            const result = await response.json();
            console.log('Progress saved:', result.progress + '%', isComplete ? '(COMPLETE)' : '');
        }
    } catch (error) {
        console.error('Error saving progress:', error);
    } finally {
        state.isSaving = false;
    }
}

// DOM Elements
const chatMessages = document.getElementById('chat-messages');
const inputArea = document.getElementById('input-area');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');

// Confetti function
function launchConfetti() {
    const duration = 1500;
    const end = Date.now() + duration;

    const colors = ['#f59e0b', '#000000', '#ffffff'];

    (function frame() {
        confetti({
            particleCount: 2,
            angle: 60,
            spread: 55,
            origin: { x: 0 },
            colors: colors
        });
        confetti({
            particleCount: 2,
            angle: 120,
            spread: 55,
            origin: { x: 1 },
            colors: colors
        });

        if (Date.now() < end) {
            requestAnimationFrame(frame);
        }
    }());
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const savedProgress = loadSavedProgress();

    // Check if already completed
    if (savedProgress && savedProgress.isComplete) {
        // Restore state
        state.sessionId = savedProgress.sessionId;
        state.answers = savedProgress.answers || {};
        state.teamMembers = savedProgress.teamMembers || [];
        state.cLevelPartners = savedProgress.cLevelPartners || [];
        state.isComplete = true;

        // Show completion screen directly
        showCompletionScreen();
        launchConfetti();
        return;
    }

    // Check if there's saved progress to resume
    if (savedProgress && savedProgress.currentQuestion > 0) {
        // Restore state
        state.sessionId = savedProgress.sessionId;
        state.currentQuestion = savedProgress.currentQuestion;
        state.answers = savedProgress.answers || {};
        state.teamMembers = savedProgress.teamMembers || [];
        state.cLevelPartners = savedProgress.cLevelPartners || [];
        state.hasTeamMembers = savedProgress.hasTeamMembers;

        // Show welcome back message and resume
        launchConfetti();
        showTyping();
        setTimeout(() => {
            addBotMessage("Welcome back! 👋 Let's pick up where you left off.");
            setTimeout(() => {
                // Replay previous answers as chat messages
                replayPreviousAnswers();
                // Then show current question
                showQuestion(state.currentQuestion);
            }, 400);
        }, 500);
        return;
    }

    // Fresh start
    launchConfetti();
    showTyping();
    setTimeout(() => {
        addBotMessage("Hey there! 👋 I'm here to help you complete your CA Pro onboarding. Let's get you set up!");
        setTimeout(() => {
            showQuestion(0);
        }, 400);
    }, 500);
});

// Replay previous Q&A for returning users
function replayPreviousAnswers() {
    for (let i = 0; i < state.currentQuestion; i++) {
        const question = questions[i];
        if (!question) continue;

        // Skip questions that were skipped due to logic (like teamMembers when no team)
        if (question.id === 'teamMembers' && state.answers.teamCount) {
            const tc = (state.answers.teamCount || '').toLowerCase().trim();
            if (tc === '0' || tc === 'zero' || tc === 'none' || tc === 'no') continue;
        }

        // Add bot question
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message message-bot';
        msgDiv.innerHTML = `<div class="message-content">${question.message.replace(/\n/g, '<br>')}</div>`;
        chatMessages.appendChild(msgDiv);

        // Add user answer
        const answer = state.answers[question.id];
        let displayAnswer = '';

        if (Array.isArray(answer)) {
            // Team members or partners
            if (answer.length > 0) {
                displayAnswer = answer.map(m => m.name).join(', ');
            } else {
                displayAnswer = 'Skipped';
            }
        } else if (answer !== undefined && answer !== null) {
            displayAnswer = String(answer);
        } else {
            displayAnswer = 'Skipped';
        }

        const userDiv = document.createElement('div');
        userDiv.className = 'message message-user';
        userDiv.innerHTML = `<div class="message-content">${displayAnswer}</div>`;
        chatMessages.appendChild(userDiv);
    }

    updateProgress();
    scrollToBottom();
}

// Show completion screen (without animation, for returning completed users)
function showCompletionScreen() {
    document.querySelector('.progress-container').style.display = 'none';
    document.querySelector('.header').style.display = 'none';

    chatMessages.innerHTML = `
        <div class="completion-container">
            <div class="completion-icon">✓</div>
            <h2 class="completion-title">You're in!</h2>
            <p class="completion-message">
                We can't wait to help you grow your business.
            </p>
            <div class="completion-checklist">
                <h3>What Happens Next:</h3>
                <ul>
                    <li>Check your email for welcome materials and login info</li>
                    <li>Your team members will receive their own onboarding emails</li>
                    <li>Connect with the community in WhatsApp</li>
                </ul>
            </div>
            <p class="completion-message">
                Questions? Reply to any of our emails or reach out in WhatsApp.
            </p>
        </div>
    `;

    inputArea.innerHTML = '';
}

// Progress Update
function updateProgress() {
    const progress = Math.round((state.currentQuestion / questions.length) * 100);
    progressBar.style.setProperty('--progress', `${progress}%`);
    progressText.textContent = `${progress}% Complete`;
}

// Show Typing Indicator
function showTyping() {
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message message-bot';
    typingDiv.id = 'typing-indicator';
    typingDiv.innerHTML = `
        <div class="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
        </div>
    `;
    chatMessages.appendChild(typingDiv);
    scrollToBottom();
}

// Remove Typing Indicator
function removeTyping() {
    const typing = document.getElementById('typing-indicator');
    if (typing) typing.remove();
}

// Add Bot Message
function addBotMessage(text) {
    removeTyping();
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message message-bot';
    messageDiv.innerHTML = `<div class="message-content">${text.replace(/\n/g, '<br>')}</div>`;
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

// Add User Message
function addUserMessage(text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message message-user';
    messageDiv.innerHTML = `<div class="message-content">${text}</div>`;
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

// Scroll to Bottom - improved to ensure input is visible
function scrollToBottom() {
    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => {
        // Scroll the chat messages container
        chatMessages.scrollTop = chatMessages.scrollHeight;
        // Also scroll the input area into view
        inputArea.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
}

// Check if team count indicates zero team members
function hasZeroTeamMembers() {
    // If AI validation completed, use that result
    if (state.hasTeamMembers !== null) {
        return !state.hasTeamMembers;
    }

    // Fallback to simple logic if AI hasn't responded yet
    const teamCount = (state.answers.teamCount || '').toLowerCase().trim();

    // Empty means skip
    if (teamCount === '') return true;

    // Exact matches for zero
    const exactZeroPatterns = ['0', 'zero', 'none', 'no', 'nope', 'n/a', 'na'];
    if (exactZeroPatterns.includes(teamCount)) return true;

    // Phrase patterns (must be the whole response or clearly indicate zero)
    const phrasePatterns = ['no team', 'just me', 'only me', 'myself', 'no one', 'nobody', 'i don\'t', 'i dont', 'don\'t have', 'dont have'];
    if (phrasePatterns.some(pattern => teamCount.includes(pattern))) return true;

    // If the response starts with a number > 0 or contains positive indicators, show the question
    const startsWithPositiveNumber = /^[1-9]/.test(teamCount);
    const hasPositiveWords = ['over', 'about', 'around', 'several', 'few', 'many', 'some', 'multiple', 'team', 'people', 'employees', 'staff'].some(word => teamCount.includes(word));

    if (startsWithPositiveNumber || hasPositiveWords) return false;

    // Default: show the team question (don't skip)
    return false;
}

// AI validation for team count (runs in background)
async function validateTeamCountWithAI(teamCountResponse) {
    try {
        const response = await fetch('/api/validate-team-count', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamCount: teamCountResponse })
        });

        if (response.ok) {
            const result = await response.json();
            state.hasTeamMembers = result.hasTeamMembers;
            console.log('AI validation result:', result.hasTeamMembers ? 'Has team members' : 'No team members');
        }
    } catch (error) {
        console.error('AI validation failed, using fallback:', error);
    }
}

// Show Question
function showQuestion(index) {
    if (index >= questions.length) {
        showCompletion();
        return;
    }

    const question = questions[index];

    // Skip team members question if team count is zero
    if (question.id === 'teamMembers' && hasZeroTeamMembers()) {
        state.currentQuestion = index + 1;
        showQuestion(state.currentQuestion);
        return;
    }

    state.currentQuestion = index;
    updateProgress();

    // Show typing indicator
    showTyping();

    // Brief typing delay (just enough to feel natural)
    setTimeout(() => {
        addBotMessage(question.message);
        renderInput(question);
        scrollToBottom();
    }, 400);
}

// Render Input Based on Type
function renderInput(question) {
    inputArea.innerHTML = '';

    switch (question.type) {
        case 'text':
            renderTextInput(question);
            break;
        case 'textarea':
            renderTextareaInput(question);
            break;
        case 'buttons':
            renderButtonsInput(question);
            break;
        case 'slider':
            renderSliderInput(question);
            break;
        case 'teamEntry':
            renderTeamEntryInput(question);
            break;
        case 'partnerEntry':
            renderPartnerEntryInput(question);
            break;
        case 'scheduling':
            renderSchedulingInput(question);
            break;
    }

    scrollToBottom();
}

// Text Input - iMessage style
function renderTextInput(question) {
    inputArea.innerHTML = `
        <div class="input-row-imessage">
            <input type="text" class="text-input" id="text-input"
                placeholder="${question.placeholder || ''}"
                onkeypress="if(event.key === 'Enter') handleTextSubmit('${question.id}')">
            <button class="send-btn" onclick="handleTextSubmit('${question.id}')">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z" transform="rotate(-90 12 12)"/>
                </svg>
            </button>
        </div>
    `;
    document.getElementById('text-input').focus();
}

function handleTextSubmit(questionId) {
    const input = document.getElementById('text-input');
    const value = input.value.trim();

    if (!value && questions[state.currentQuestion].validation?.required) {
        input.style.borderColor = '#ef4444';
        return;
    }

    // Clear input area immediately
    inputArea.innerHTML = '';

    addUserMessage(value || 'Skipped');
    state.answers[questionId] = value;

    // Trigger AI validation for team count (runs in background)
    if (questionId === 'teamCount') {
        validateTeamCountWithAI(value);
    }

    state.currentQuestion++;
    saveProgress(); // Save progress after each answer
    showQuestion(state.currentQuestion);
}

// Textarea Input - iMessage style with auto-expand
function renderTextareaInput(question) {
    inputArea.innerHTML = `
        <div class="input-row-imessage">
            <textarea class="text-input auto-expand" id="textarea-input"
                placeholder="${question.placeholder || ''}"
                rows="1"
                onkeydown="if(event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleTextareaSubmit('${question.id}', ${question.optional || false}); }"
                oninput="autoExpand(this)"></textarea>
            <button class="send-btn" onclick="handleTextareaSubmit('${question.id}', ${question.optional || false})">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z" transform="rotate(-90 12 12)"/>
                </svg>
            </button>
        </div>
    `;
    document.getElementById('textarea-input').focus();
}

// Auto-expand textarea as user types
function autoExpand(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
}

function handleTextareaSubmit(questionId, optional) {
    const input = document.getElementById('textarea-input');
    const value = input.value.trim();

    if (!value && !optional) {
        input.style.borderColor = '#ef4444';
        return;
    }

    // Clear input area immediately
    inputArea.innerHTML = '';

    addUserMessage(value || 'Skipped');
    state.answers[questionId] = value;
    state.currentQuestion++;
    saveProgress(); // Save progress after each answer
    showQuestion(state.currentQuestion);
}

// Buttons Input
function renderButtonsInput(question) {
    const buttonsHtml = question.options.map((opt, index) =>
        `<button class="option-btn" data-index="${index}">${opt.label}</button>`
    ).join('');

    inputArea.innerHTML = `
        <div class="button-group">
            ${buttonsHtml}
        </div>
    `;

    // Add click handlers (avoids issues with apostrophes in labels)
    document.querySelectorAll('.option-btn').forEach((btn, index) => {
        btn.addEventListener('click', () => {
            const opt = question.options[index];
            handleButtonSelect(question.id, opt.value, opt.label);
        });
    });
}

function handleButtonSelect(questionId, value, label) {
    // Clear input area immediately
    inputArea.innerHTML = '';

    addUserMessage(label);
    state.answers[questionId] = value;
    state.currentQuestion++;
    saveProgress(); // Save progress after each answer
    showQuestion(state.currentQuestion);
}

// Scheduling Input (for 1:1 call booking)
function renderSchedulingInput(question) {
    const optionsHtml = question.options.map((opt, index) => `
        <div class="scheduling-card">
            <div class="scheduling-card-top">
                <img src="${opt.image}" alt="${opt.name}" class="scheduling-pfp">
                <div class="scheduling-card-info">
                    <strong>${opt.name}</strong>
                    <p class="scheduling-card-desc">${opt.description}</p>
                </div>
            </div>
            <a href="${opt.url}" target="_blank" class="scheduling-book-btn" data-index="${index}">
                Book with ${opt.name}
            </a>
        </div>
    `).join('');

    inputArea.innerHTML = `
        <div class="scheduling-container">
            ${optionsHtml}
            <button class="skip-btn" id="skip-scheduling">Skip for Now</button>
        </div>
    `;

    // Track when someone clicks a booking link
    document.querySelectorAll('.scheduling-book-btn').forEach((btn, index) => {
        btn.addEventListener('click', () => {
            const opt = question.options[index];
            // Mark that they clicked to book (link opens in new tab)
            setTimeout(() => {
                handleSchedulingSelect(question.id, opt.value, `Booking with ${opt.name}`);
            }, 500);
        });
    });

    // Skip button
    document.getElementById('skip-scheduling').addEventListener('click', () => {
        handleSchedulingSelect(question.id, 'skipped', 'Skipped');
    });
}

function handleSchedulingSelect(questionId, value, label) {
    // Clear input area immediately
    inputArea.innerHTML = '';

    addUserMessage(label);
    state.answers[questionId] = value;
    state.currentQuestion++;
    saveProgress();
    showQuestion(state.currentQuestion);
}

// Slider Input
function renderSliderInput(question) {
    inputArea.innerHTML = `
        <div class="slider-container">
            <div class="slider-value" id="slider-value">${question.defaultValue}</div>
            <div class="slider-track-wrapper">
                <input type="range" class="slider-input" id="slider-input"
                    min="${question.min}" max="${question.max}" value="${question.defaultValue}"
                    oninput="document.getElementById('slider-value').textContent = this.value">
            </div>
            <div class="slider-labels">
                <span>${question.labels.left}</span>
                <span>${question.labels.right}</span>
            </div>
            <button class="submit-btn" onclick="handleSliderSubmit('${question.id}')">
                Continue
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
            </button>
        </div>
    `;

    // Disable page scroll while using slider on mobile
    const slider = document.getElementById('slider-input');
    slider.addEventListener('touchstart', lockScroll);
    slider.addEventListener('touchend', unlockScroll);
    slider.addEventListener('touchcancel', unlockScroll);
}

// Lock/unlock scroll for slider interaction
function lockScroll() {
    document.body.classList.add('scroll-locked');
}

function unlockScroll() {
    document.body.classList.remove('scroll-locked');
}

function handleSliderSubmit(questionId) {
    const value = document.getElementById('slider-input').value;

    // Clear input area immediately
    inputArea.innerHTML = '';

    addUserMessage(value);
    state.answers[questionId] = parseInt(value);
    state.currentQuestion++;
    saveProgress(); // Save progress after each answer
    showQuestion(state.currentQuestion);
}

// Team Entry Input (just name, email, phone)
function renderTeamEntryInput(question) {
    const members = state.teamMembers;

    let membersHtml = members.map((member, index) => `
        <div class="team-member-card" data-index="${index}">
            <div class="input-row full">
                <input type="text" placeholder="Name *" value="${member.name || ''}"
                    onchange="updateTeamMember(${index}, 'name', this.value)">
            </div>
            <div class="input-row">
                <input type="email" placeholder="Email Address *" value="${member.email || ''}"
                    onchange="updateTeamMember(${index}, 'email', this.value)">
                <input type="tel" placeholder="Phone Number *" value="${member.phone || ''}"
                    onchange="updateTeamMember(${index}, 'phone', this.value)">
            </div>
            <button class="remove-btn" onclick="removeTeamMember(${index})">Remove</button>
        </div>
    `).join('');

    // Show prominent Continue button if members added, subtle skip if not
    const actionButton = members.length === 0
        ? `<button class="skip-btn" onclick="handleTeamEntrySubmit('${question.id}')">Skip for Now</button>`
        : `<button class="submit-btn" onclick="handleTeamEntrySubmit('${question.id}')">
                Continue
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
           </button>`;

    inputArea.innerHTML = `
        <div class="team-entry-container">
            ${membersHtml}
            <button class="add-member-btn" onclick="addTeamMember()">
                ${question.addButtonText}
            </button>
            ${actionButton}
        </div>
    `;
}

function addTeamMember() {
    state.teamMembers.push({ name: '', email: '', phone: '' });
    renderTeamEntryInput(questions[state.currentQuestion]);
    scrollToBottom();
}

function removeTeamMember(index) {
    state.teamMembers.splice(index, 1);
    renderTeamEntryInput(questions[state.currentQuestion]);
}

function updateTeamMember(index, field, value) {
    state.teamMembers[index][field] = value;
}

function handleTeamEntrySubmit(questionId) {
    const members = state.teamMembers;

    // If there are members, validate all fields are filled
    if (members.length > 0) {
        let hasError = false;
        members.forEach((m, index) => {
            if (!m.name || !m.email || !m.phone) {
                hasError = true;
                // Highlight empty fields
                const card = document.querySelectorAll('.team-member-card')[index];
                if (card) {
                    card.querySelectorAll('input').forEach(input => {
                        if (!input.value.trim()) {
                            input.classList.add('error');
                        } else {
                            input.classList.remove('error');
                        }
                    });
                }
            }
        });

        if (hasError) {
            alert('Please fill in all fields for each team member.');
            return;
        }
    }

    // Clear input area immediately
    inputArea.innerHTML = '';

    if (members.length > 0) {
        const summary = members.map(m => m.name).join(', ');
        addUserMessage(summary);
    } else {
        addUserMessage('Skipped');
    }

    state.answers[questionId] = members;
    state.currentQuestion++;
    saveProgress(); // Save progress after each answer
    showQuestion(state.currentQuestion);
}

// Partner Entry Input (just name, email, phone)
function renderPartnerEntryInput(question) {
    const partners = state.cLevelPartners;

    let partnersHtml = partners.map((partner, index) => `
        <div class="team-member-card" data-index="${index}">
            <div class="input-row full">
                <input type="text" placeholder="Name *" value="${partner.name || ''}"
                    onchange="updatePartner(${index}, 'name', this.value)">
            </div>
            <div class="input-row">
                <input type="email" placeholder="Email Address *" value="${partner.email || ''}"
                    onchange="updatePartner(${index}, 'email', this.value)">
                <input type="tel" placeholder="Phone Number *" value="${partner.phone || ''}"
                    onchange="updatePartner(${index}, 'phone', this.value)">
            </div>
            <button class="remove-btn" onclick="removePartner(${index})">Remove</button>
        </div>
    `).join('');

    // Show prominent Continue button if partners added, subtle skip if not
    const actionButton = partners.length === 0
        ? `<button class="skip-btn" onclick="handlePartnerEntrySubmit('${question.id}')">Skip for Now</button>`
        : `<button class="submit-btn" onclick="handlePartnerEntrySubmit('${question.id}')">
                Continue
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
           </button>`;

    inputArea.innerHTML = `
        <div class="team-entry-container">
            ${partnersHtml}
            <button class="add-member-btn" onclick="addPartner()">
                ${question.addButtonText}
            </button>
            ${actionButton}
        </div>
    `;
}

function addPartner() {
    state.cLevelPartners.push({ name: '', email: '', phone: '' });
    renderPartnerEntryInput(questions[state.currentQuestion]);
    scrollToBottom();
}

function removePartner(index) {
    state.cLevelPartners.splice(index, 1);
    renderPartnerEntryInput(questions[state.currentQuestion]);
}

function updatePartner(index, field, value) {
    state.cLevelPartners[index][field] = value;
}

function handlePartnerEntrySubmit(questionId) {
    const partners = state.cLevelPartners;

    // If there are partners, validate all fields are filled
    if (partners.length > 0) {
        let hasError = false;
        partners.forEach((p, index) => {
            if (!p.name || !p.email || !p.phone) {
                hasError = true;
                // Highlight empty fields
                const card = document.querySelectorAll('.team-member-card')[index];
                if (card) {
                    card.querySelectorAll('input').forEach(input => {
                        if (!input.value.trim()) {
                            input.classList.add('error');
                        } else {
                            input.classList.remove('error');
                        }
                    });
                }
            }
        });

        if (hasError) {
            alert('Please fill in all fields for each partner.');
            return;
        }
    }

    // Clear input area immediately
    inputArea.innerHTML = '';

    if (partners.length > 0) {
        const summary = partners.map(p => p.name).join(', ');
        addUserMessage(summary);
    } else {
        addUserMessage('Skipped');
    }

    state.answers[questionId] = partners;
    state.currentQuestion++;
    saveProgress(); // Save progress after each answer
    showQuestion(state.currentQuestion);
}

// Show Completion
async function showCompletion() {
    // Log all collected data
    console.log('=== CA Pro Onboarding Data ===');
    console.log(JSON.stringify(state.answers, null, 2));
    console.log('Team Members:', state.teamMembers);
    console.log('C-Level Partners:', state.cLevelPartners);

    // Clear input area immediately
    inputArea.innerHTML = '';

    // Save final data with isComplete=true (keeps in localStorage for returning users)
    await saveProgress(true);

    // Hide progress bar and header
    document.querySelector('.progress-container').style.display = 'none';
    document.querySelector('.header').style.display = 'none';

    // Animate the chat messages out
    chatMessages.classList.add('chat-fade-out');

    // Wait for fade out, then show completion screen
    setTimeout(() => {
        // Clear and show completion
        chatMessages.innerHTML = `
            <div class="completion-container">
                <div class="completion-icon">✓</div>
                <h2 class="completion-title">You're in!</h2>
                <p class="completion-message">
                    We can't wait to help you grow your business.
                </p>
                <div class="completion-checklist">
                    <h3>What Happens Next:</h3>
                    <ul>
                        <li>Check your email for welcome materials and login info</li>
                        <li>Your team members will receive their own onboarding emails</li>
                        <li>Connect with the community in WhatsApp</li>
                    </ul>
                </div>
                <p class="completion-message">
                    Questions? Reply to any of our emails or reach out in WhatsApp.
                </p>
            </div>
        `;
        chatMessages.classList.remove('chat-fade-out');

        // Launch confetti
        launchConfetti();

        scrollToBottom();
    }, 400);
}
