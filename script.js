// CA Pro Onboarding Chat Interface

// State Management
const state = {
    currentQuestion: 0,
    answers: {},
    teamMembers: [],
    cLevelPartners: [],
    isTyping: false
};

// Questions Configuration
const questions = [
    {
        id: 'welcome',
        type: 'welcome',
        message: "Hey there! 👋 I'm here to help you complete your CA Pro onboarding. We already have some info from your application - let's fill in the rest so we can get you fully set up!",
        buttonText: "Let's Get Started"
    },
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
        message: "How many team members do you currently have, and want inside CA Pro?",
        placeholder: "5 team members",
        validation: { required: true }
    },
    {
        id: 'trafficSources',
        type: 'textarea',
        message: "What traffic sources do you typically use to acquire customers?",
        placeholder: "Facebook Ads, Google Ads, Email Marketing, Influencer partnerships, Organic social...",
        validation: { required: true }
    },
    {
        id: 'landingPages',
        type: 'textarea',
        message: "Please share links to your landing pages, product pages, or any ads/creative assets. The more we see, the better we can help!",
        placeholder: "Paste URLs here, one per line...",
        validation: { required: true }
    },
    {
        id: 'massiveWin',
        type: 'textarea',
        message: "What's the #1 thing that, if CA Pro helped you achieve, would be a MASSIVE win for your business?",
        placeholder: "Be specific - this helps us tailor our support to your goals...",
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
        message: "Let's set up your team access! Who should be added to the Training Group? They'll get access to weekly trainings, the member's area, and all past courses. You can add as many team members as you'd like.",
        fields: ['firstName', 'lastName', 'email', 'phone', 'role'],
        addButtonText: '+ Add Team Member',
        optional: true
    },
    {
        id: 'cLevelPartners',
        type: 'partnerEntry',
        message: "Any C-Level executives or business partners you'd like added to the Business Owner WhatsApp group? They'll get access to owner-level discussions and the member's area.",
        fields: ['firstName', 'lastName', 'email', 'phone'],
        addButtonText: '+ Add Partner',
        optional: true
    },
    {
        id: 'bio',
        type: 'textarea',
        message: "Share a quick bio about yourself for our member directory. This helps other business owners and their teams get to know you!",
        placeholder: "A few sentences about your background, expertise, and what you're working on...",
        validation: { required: true }
    },
    {
        id: 'headshotLink',
        type: 'text',
        message: "Please share a link to a headshot or professional photo for your directory profile. You can submit a social media link if you don't have this.",
        placeholder: "https://drive.google.com/... or social media profile link",
        validation: { required: true }
    },
    {
        id: 'whatsappNumber',
        type: 'text',
        message: "What's your WhatsApp number? We'll use this to identify you when you join the community.",
        placeholder: "+1 (555) 123-4567",
        validation: { required: true }
    },
    {
        id: 'whatsappJoined',
        type: 'buttons',
        message: "Have you joined our WhatsApp community yet? This is where most of the mastermind communication happens!\n\n👉 <a href=\"https://chat.whatsapp.com/KMVMZEWvJadLrVGY672wkM\" target=\"_blank\">Click To Join WhatsApp</a>",
        options: [
            { value: 'done', label: "Yes, I've joined!" },
            { value: 'later', label: "I'll do it later" }
        ]
    },
    {
        id: 'anythingElse',
        type: 'textarea',
        message: "Last one! Is there anything else you'd like us to know about you or your business?",
        placeholder: "Optional - share anything that might help us serve you better...",
        optional: true
    }
];

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
    // Launch confetti on page load
    launchConfetti();
    showQuestion(0);
});

// Progress Update
function updateProgress() {
    const progress = Math.round((state.currentQuestion / (questions.length - 1)) * 100);
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

// Scroll to Bottom
function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Show Question
function showQuestion(index) {
    if (index >= questions.length) {
        showCompletion();
        return;
    }

    const question = questions[index];
    state.currentQuestion = index;
    updateProgress();

    // Show typing indicator
    showTyping();

    // Simulate typing delay
    setTimeout(() => {
        addBotMessage(question.message);
        renderInput(question);
    }, 800);
}

// Render Input Based on Type
function renderInput(question) {
    inputArea.innerHTML = '';

    switch (question.type) {
        case 'welcome':
            renderWelcomeInput(question);
            break;
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
    }
}

// Welcome Input
function renderWelcomeInput(question) {
    inputArea.innerHTML = `
        <button class="submit-btn" onclick="handleWelcome()">
            ${question.buttonText}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
        </button>
    `;
}

function handleWelcome() {
    state.currentQuestion++;
    showQuestion(state.currentQuestion);
}

// Text Input - iMessage style
function renderTextInput(question) {
    inputArea.innerHTML = `
        <div class="input-row-imessage">
            <input type="text" class="text-input" id="text-input"
                placeholder="${question.placeholder || ''}"
                onkeypress="if(event.key === 'Enter') handleTextSubmit('${question.id}')">
            <button class="send-btn" onclick="handleTextSubmit('${question.id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
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

    addUserMessage(value || 'Skipped');
    state.answers[questionId] = value;
    state.currentQuestion++;
    showQuestion(state.currentQuestion);
}

// Textarea Input - iMessage style
function renderTextareaInput(question) {
    inputArea.innerHTML = `
        <div class="input-row-imessage">
            <textarea class="text-input" id="textarea-input"
                placeholder="${question.placeholder || ''}"
                rows="2"
                onkeydown="if(event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleTextareaSubmit('${question.id}', ${question.optional || false}); }"></textarea>
            <button class="send-btn" onclick="handleTextareaSubmit('${question.id}', ${question.optional || false})">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
                </svg>
            </button>
        </div>
    `;
    document.getElementById('textarea-input').focus();
}

function handleTextareaSubmit(questionId, optional) {
    const input = document.getElementById('textarea-input');
    const value = input.value.trim();

    if (!value && !optional) {
        input.style.borderColor = '#ef4444';
        return;
    }

    addUserMessage(value || 'Skipped');
    state.answers[questionId] = value;
    state.currentQuestion++;
    showQuestion(state.currentQuestion);
}

// Buttons Input
function renderButtonsInput(question) {
    const buttonsHtml = question.options.map(opt =>
        `<button class="option-btn" onclick="handleButtonSelect('${question.id}', '${opt.value}', '${opt.label}')">${opt.label}</button>`
    ).join('');

    inputArea.innerHTML = `
        <div class="button-group">
            ${buttonsHtml}
        </div>
    `;
}

function handleButtonSelect(questionId, value, label) {
    addUserMessage(label);
    state.answers[questionId] = value;
    state.currentQuestion++;
    showQuestion(state.currentQuestion);
}

// Slider Input
function renderSliderInput(question) {
    inputArea.innerHTML = `
        <div class="slider-container">
            <div class="slider-value" id="slider-value">${question.defaultValue}</div>
            <input type="range" class="slider-input" id="slider-input"
                min="${question.min}" max="${question.max}" value="${question.defaultValue}"
                oninput="document.getElementById('slider-value').textContent = this.value">
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
}

function handleSliderSubmit(questionId) {
    const value = document.getElementById('slider-input').value;
    addUserMessage(`${value}/10`);
    state.answers[questionId] = parseInt(value);
    state.currentQuestion++;
    showQuestion(state.currentQuestion);
}

// Team Entry Input (with phone and role, all fields required)
function renderTeamEntryInput(question) {
    const members = state.teamMembers;

    let membersHtml = members.map((member, index) => `
        <div class="team-member-card" data-index="${index}">
            <div class="input-row">
                <input type="text" placeholder="First Name *" value="${member.firstName || ''}"
                    onchange="updateTeamMember(${index}, 'firstName', this.value)">
                <input type="text" placeholder="Last Name *" value="${member.lastName || ''}"
                    onchange="updateTeamMember(${index}, 'lastName', this.value)">
            </div>
            <div class="input-row">
                <input type="email" placeholder="Email Address *" value="${member.email || ''}"
                    onchange="updateTeamMember(${index}, 'email', this.value)">
                <input type="tel" placeholder="Phone Number *" value="${member.phone || ''}"
                    onchange="updateTeamMember(${index}, 'phone', this.value)">
            </div>
            <div class="input-row full">
                <input type="text" placeholder="Role (Copywriter, Marketing Manager, etc.) *" value="${member.role || ''}"
                    onchange="updateTeamMember(${index}, 'role', this.value)">
            </div>
            <button class="remove-btn" onclick="removeTeamMember(${index})">Remove</button>
        </div>
    `).join('');

    inputArea.innerHTML = `
        <div class="team-entry-container">
            ${membersHtml}
            <button class="add-member-btn" onclick="addTeamMember()">
                ${question.addButtonText}
            </button>
            <button class="submit-btn" onclick="handleTeamEntrySubmit('${question.id}')">
                ${members.length === 0 ? 'Skip for Now' : 'Continue'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
            </button>
        </div>
    `;
}

function addTeamMember() {
    state.teamMembers.push({ firstName: '', lastName: '', email: '', phone: '', role: '' });
    renderTeamEntryInput(questions[state.currentQuestion]);
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
            if (!m.firstName || !m.lastName || !m.email || !m.phone || !m.role) {
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

    if (members.length > 0) {
        const summary = members.map(m => `${m.firstName} ${m.lastName} (${m.role})`).join(', ');
        addUserMessage(summary);
    } else {
        addUserMessage('Skipped');
    }

    state.answers[questionId] = members;
    state.currentQuestion++;
    showQuestion(state.currentQuestion);
}

// Partner Entry Input (with phone, no role, all fields required)
function renderPartnerEntryInput(question) {
    const partners = state.cLevelPartners;

    let partnersHtml = partners.map((partner, index) => `
        <div class="team-member-card" data-index="${index}">
            <div class="input-row">
                <input type="text" placeholder="First Name *" value="${partner.firstName || ''}"
                    onchange="updatePartner(${index}, 'firstName', this.value)">
                <input type="text" placeholder="Last Name *" value="${partner.lastName || ''}"
                    onchange="updatePartner(${index}, 'lastName', this.value)">
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

    inputArea.innerHTML = `
        <div class="team-entry-container">
            ${partnersHtml}
            <button class="add-member-btn" onclick="addPartner()">
                ${question.addButtonText}
            </button>
            <button class="submit-btn" onclick="handlePartnerEntrySubmit('${question.id}')">
                ${partners.length === 0 ? 'Skip for Now' : 'Continue'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
            </button>
        </div>
    `;
}

function addPartner() {
    state.cLevelPartners.push({ firstName: '', lastName: '', email: '', phone: '' });
    renderPartnerEntryInput(questions[state.currentQuestion]);
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
            if (!p.firstName || !p.lastName || !p.email || !p.phone) {
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

    if (partners.length > 0) {
        const summary = partners.map(p => `${p.firstName} ${p.lastName}`).join(', ');
        addUserMessage(summary);
    } else {
        addUserMessage('Skipped');
    }

    state.answers[questionId] = partners;
    state.currentQuestion++;
    showQuestion(state.currentQuestion);
}

// Show Completion
function showCompletion() {
    updateProgress();

    // Log all collected data
    console.log('=== CA Pro Onboarding Data ===');
    console.log(JSON.stringify(state.answers, null, 2));
    console.log('Team Members:', state.teamMembers);
    console.log('C-Level Partners:', state.cLevelPartners);

    inputArea.innerHTML = '';

    const completionHtml = `
        <div class="completion-container">
            <div class="completion-icon">✓</div>
            <h2 class="completion-title">You're All Set!</h2>
            <p class="completion-message">
                Thanks for completing your CA Pro onboarding. We're excited to have you in the community!
            </p>
            <div class="completion-checklist">
                <h3>What Happens Next:</h3>
                <ul>
                    <li>Check your email for welcome materials and login info</li>
                    <li>Your team members will receive their own onboarding emails</li>
                    <li>Join the WhatsApp community if you haven't already</li>
                </ul>
            </div>
            <p class="completion-message">
                Questions? Reply to any of our emails or reach out in WhatsApp.
            </p>
        </div>
    `;

    showTyping();
    setTimeout(() => {
        addBotMessage("🎉 Amazing! You've completed the onboarding!");
        setTimeout(() => {
            chatMessages.innerHTML += completionHtml;
            scrollToBottom();
            // Launch confetti on completion too
            launchConfetti();
        }, 500);
    }, 800);
}
