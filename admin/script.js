// CA Pro Admin Dashboard

const API_BASE = '/api';
const ADMIN_PASSWORD = '2323';

// State
let currentTab = 'overview';
let applicationsPage = 0;
let membersPage = 0;
let teamMembersPage = 0;
let cancellationsPage = 0;
const pageSize = 20;

// Monday-style board state (applications)
let applicationsLastResponse = null;
let applicationsTableUXInitialized = false;
let applicationsGroupCollapsed = (() => {
    try {
        return JSON.parse(localStorage.getItem('admin.applications.groupCollapsed') || '{}') || {};
    } catch {
        return {};
    }
})();
let applicationsSort = (() => {
    try {
        return JSON.parse(localStorage.getItem('admin.applications.sort') || 'null') || { key: 'created_at', dir: 'desc' };
    } catch {
        return { key: 'created_at', dir: 'desc' };
    }
})();

// Monday-style board state (members)
let membersLastResponse = null;
let membersTableUXInitialized = false;
let membersGroupCollapsed = (() => {
    try {
        return JSON.parse(localStorage.getItem('admin.members.groupCollapsed') || '{}') || {};
    } catch {
        return {};
    }
})();
let membersSort = (() => {
    try {
        return JSON.parse(localStorage.getItem('admin.members.sort') || 'null') || { key: 'created_at', dir: 'desc' };
    } catch {
        return { key: 'created_at', dir: 'desc' };
    }
})();

// Monday-style board state (team members)
let teamMembersLastResponse = null;
let teamMembersTableUXInitialized = false;
let teamMembersGroupCollapsed = (() => {
    try {
        return JSON.parse(localStorage.getItem('admin.teamMembers.groupCollapsed') || '{}') || {};
    } catch {
        return {};
    }
})();
let teamMembersSort = (() => {
    try {
        return JSON.parse(localStorage.getItem('admin.teamMembers.sort') || 'null') || { key: 'created_at', dir: 'desc' };
    } catch {
        return { key: 'created_at', dir: 'desc' };
    }
})();

// Password Gate
function checkAuth() {
    return sessionStorage.getItem('admin_authenticated') === 'true';
}

function setupPasswordGate() {
    const passwordGate = document.getElementById('password-gate');
    const app = document.getElementById('app');
    const passwordForm = document.getElementById('password-form');
    const passwordInput = document.getElementById('password-input');
    const passwordError = document.getElementById('password-error');

    if (checkAuth()) {
        passwordGate.style.display = 'none';
        app.style.display = 'flex';
        return true;
    }

    passwordForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const enteredPassword = passwordInput.value;

        if (enteredPassword === ADMIN_PASSWORD) {
            sessionStorage.setItem('admin_authenticated', 'true');
            passwordGate.style.display = 'none';
            app.style.display = 'flex';
            initializeDashboard();
        } else {
            passwordError.textContent = 'Incorrect password';
            passwordInput.value = '';
            passwordInput.focus();
        }
    });

    return false;
}

function initializeDashboard() {
    setupNavigation();
    setupSearch();
    setupFilters();
    setupImport();
    loadOverview();
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    if (setupPasswordGate()) {
        initializeDashboard();
    }
});

// Navigation
function setupNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const tab = item.dataset.tab;
            switchTab(tab);
        });
    });
}

function switchTab(tab) {
    currentTab = tab;

    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.tab === tab);
    });

    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `tab-${tab}`);
    });

    // Load data
    switch (tab) {
        case 'overview':
            loadOverview();
            break;
        case 'applications':
            loadApplications();
            break;
        case 'members':
            loadMembers();
            break;
        case 'team-members':
            loadTeamMembers();
            break;
        case 'cancellations':
            loadCancellations();
            break;
        case 'onboarding':
            loadOnboarding();
            break;
        case 'import':
            loadImportHistory();
            break;
    }
}

// Search setup
function setupSearch() {
    const applicationsSearch = document.getElementById('applications-search');
    const membersSearch = document.getElementById('members-search');
    const teamMembersSearch = document.getElementById('team-members-search');
    const cancellationsSearch = document.getElementById('cancellations-search');
    const submissionsSearch = document.getElementById('submissions-search');

    let searchTimeout;

    [applicationsSearch, membersSearch, teamMembersSearch, cancellationsSearch, submissionsSearch].forEach(input => {
        if (input) {
            input.addEventListener('input', () => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    if (input === applicationsSearch) {
                        applicationsPage = 0;
                        loadApplications();
                    } else if (input === membersSearch) {
                        membersPage = 0;
                        loadMembers();
                    } else if (input === teamMembersSearch) {
                        teamMembersPage = 0;
                        loadTeamMembers();
                    } else if (input === cancellationsSearch) {
                        cancellationsPage = 0;
                        loadCancellations();
                    } else if (input === submissionsSearch) {
                        loadOnboarding();
                    }
                }, 300);
            });
        }
    });
}

// Filter setup
function setupFilters() {
    const applicationsFilter = document.getElementById('applications-filter');
    const membersSourceFilter = document.getElementById('members-source-filter');
    const membersStatusFilter = document.getElementById('members-status-filter');

    if (applicationsFilter) {
        applicationsFilter.addEventListener('change', () => {
            applicationsPage = 0;
            loadApplications();
        });
    }

    if (membersSourceFilter) {
        membersSourceFilter.addEventListener('change', () => {
            membersPage = 0;
            loadMembers();
        });
    }

    if (membersStatusFilter) {
        membersStatusFilter.addEventListener('change', () => {
            membersPage = 0;
            loadMembers();
        });
    }

    const submissionsFilter = document.getElementById('submissions-filter');
    if (submissionsFilter) {
        submissionsFilter.addEventListener('change', () => {
            loadOnboarding();
        });
    }
}

// Overview
async function loadOverview() {
    try {
        const stats = await fetchAPI('/stats');

        // Update stat cards
        document.getElementById('stat-members').textContent = stats.totals.members;
        document.getElementById('stat-pending').textContent = stats.totals.pending_onboardings;
        document.getElementById('stat-applications').textContent = stats.totals.recent_applications;
        document.getElementById('stat-team').textContent = stats.totals.team_members;

        // Update badge - only count truly new applications (without matching onboarding)
        const badge = document.getElementById('new-applications-badge');
        const newCount = stats.truly_new_applications || 0;
        badge.textContent = newCount;
        badge.style.display = newCount > 0 ? 'inline' : 'none';

        // Activity feed
        renderActivityFeed(stats.recent_activity);

        // Status chart
        renderStatusChart(stats.onboarding_status);
    } catch (error) {
        console.error('Error loading overview:', error);
        showToast('Failed to load dashboard', 'error');
    }
}

function renderActivityFeed(activities) {
    const feed = document.getElementById('activity-feed');

    if (!activities || activities.length === 0) {
        feed.innerHTML = '<p style="color: var(--gray-400); text-align: center; padding: 20px;">No recent activity</p>';
        return;
    }

    feed.innerHTML = activities.map(activity => {
        const iconClass = getActivityIcon(activity.action);
        const text = formatActivityText(activity);
        const time = formatTimeAgo(activity.created_at);

        return `
            <div class="activity-item">
                <div class="activity-icon ${iconClass}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        ${getActivitySVG(activity.action)}
                    </svg>
                </div>
                <div class="activity-content">
                    <div class="activity-text">${text}</div>
                    <div class="activity-time">${time}</div>
                </div>
            </div>
        `;
    }).join('');
}

function getActivityIcon(action) {
    if (action.includes('slack')) return 'slack';
    if (action.includes('monday')) return 'sync';
    if (action.includes('payment') || action.includes('samcart')) return 'payment';
    if (action.includes('email')) return 'email';
    if (action.includes('call_booked')) return 'call';
    if (action.includes('note')) return 'note';
    if (action.includes('circle') || action.includes('activecampaign')) return 'sync';
    if (action.includes('import')) return 'import';
    if (action.includes('created') || action.includes('new')) return 'new';
    if (action.includes('updated') || action.includes('completed')) return 'update';
    return 'update';
}

function getActivitySVG(action) {
    // Slack - chat bubble
    if (action.includes('slack')) {
        return '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';
    }
    // Monday/sync - refresh arrows
    if (action.includes('monday') || action.includes('circle') || action.includes('activecampaign')) {
        return '<path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>';
    }
    // Payment - credit card
    if (action.includes('payment') || action.includes('samcart')) {
        return '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>';
    }
    // Email - envelope
    if (action.includes('email')) {
        return '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>';
    }
    // Call booked - calendar
    if (action.includes('call_booked')) {
        return '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>';
    }
    // Note - pencil/edit
    if (action.includes('note')) {
        return '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>';
    }
    // New/created - plus
    if (action.includes('created') || action.includes('new')) {
        return '<path d="M12 5v14M5 12h14"/>';
    }
    // Import - upload
    if (action.includes('import')) {
        return '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>';
    }
    // Default - edit pencil
    return '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>';
}

function formatActivityText(activity) {
    const details = activity.details || {};
    switch (activity.action) {
        case 'member_created':
            return `New member added: <strong>${details.name || 'Unknown'}</strong>`;
        case 'member_updated':
            return `Member updated: <strong>${details.fields?.join(', ') || 'details'}</strong>`;
        case 'team_member_created':
            return `New team member: <strong>${details.name || 'Unknown'}</strong> (${details.role || 'N/A'})`;
        case 'new_application':
            return `New application from: <strong>${details.name || 'Unknown'}</strong>`;
        case 'application_status_changed':
            return `Application status changed to <strong>${details.status}</strong>: ${details.name || 'Unknown'}`;
        case 'onboarding_completed':
            return `Chat completed: <strong>${details.business_name || details.business || details.email || 'Unknown'}</strong>`;
        case 'csv_import':
            return `CSV imported: ${details.imported} ${details.type} records`;
        case 'typeform_sync':
            return `Typeform sync: ${details.synced} new applications`;
        case 'new_payment':
        case 'samcart_order':
            const amount = details.amount ? `$${details.amount}` : '';
            return `Payment received: <strong>${details.name || 'Unknown'}</strong> ${amount ? `- ${amount}` : ''} ${details.product ? `(${details.product})` : ''}`;
        case 'record_matched':
            return `Records matched: <strong>${details.typeform_name || 'Typeform'}</strong> → <strong>${details.onboarding_name || 'Onboarding'}</strong>`;
        case 'delayed_welcome_sent':
            return `Delayed welcome sent: <strong>${details.name || 'Unknown'}</strong> (${details.reason || 'OnboardingChat not completed'})`;
        case 'circle_team_member_synced':
            return `Circle: ${details.count || 1} team member(s) synced to communities`;
        case 'circle_partner_synced':
            return `Circle: ${details.count || 1} partner(s) synced to communities`;
        case 'circle_sync_failed':
            return `Circle sync failed: ${details.errors?.length || 1} error(s) for ${details.type || 'contacts'}`;
        case 'activecampaign_team_member_synced':
            return `ActiveCampaign: ${details.count || 1} team member(s) synced`;
        case 'activecampaign_partner_synced':
            return `ActiveCampaign: ${details.count || 1} partner(s) synced`;
        case 'activecampaign_sync_failed':
            return `ActiveCampaign sync failed: <strong>${details.email || 'Unknown'}</strong>`;
        case 'monday_team_member_synced':
            return `Monday: ${details.count || 1} team member(s) added to PRO Team Members board`;
        case 'monday_partner_synced':
            return `Monday: ${details.count || 1} partner(s) added as subitems`;
        case 'monday_sync_failed':
            return `Monday sync failed: ${details.errors?.length || 1} error(s)`;
        case 'email_sent':
            return `Email sent to <strong>${details.email || 'Unknown'}</strong>`;
        case 'email_send_failed':
            return `Email failed to <strong>${details.email || 'Unknown'}</strong>: ${details.error || 'Error'}`;
        case 'email_reply_received':
            return `Email reply from <strong>${details.email || 'Unknown'}</strong>`;
        case 'email_reply_sent':
            return `Email reply sent to <strong>${details.email || 'Unknown'}</strong>`;
        case 'call_booked':
            return `Call booked: <strong>${details.email || 'Unknown'}</strong>`;
        case 'whatsapp_joined':
            return `WhatsApp joined: <strong>${details.email || details.business_name || 'Unknown'}</strong>`;
        case 'note_added':
            return `Note added by <strong>${details.created_by || 'admin'}</strong>`;
        case 'slack_thread_created':
            return `Slack thread created for <strong>${details.email || 'Unknown'}</strong>`;
        case 'onboarding_started':
            return `Onboarding started: <strong>${details.email || 'Unknown'}</strong>`;
        case 'onboarding_completed':
            return `Onboarding completed: <strong>${details.business_name || details.email || 'Unknown'}</strong>`;
        case 'slack_welcome_updated':
            return `Welcome message updated: <strong>${details.business_name || details.email || 'Unknown'}</strong>`;
        case 'slack_onboarding_update_posted':
            return `Onboarding update posted: <strong>${details.business_name || details.email || 'Unknown'}</strong>`;
        case 'monday_company_updated':
            return `Monday company updated: <strong>${details.business_name || details.email || 'Unknown'}</strong>`;
        case 'monday_business_owner_created':
            return `Monday: New Business Owner added: <strong>${details.name || details.email || 'Unknown'}</strong>`;
        case 'monday_business_owner_created_retry':
            return `Monday: Business Owner added (retry): <strong>${details.name || details.email || 'Unknown'}</strong>`;
        default:
            return activity.action.replace(/_/g, ' ');
    }
}

function renderStatusChart(status) {
    const chart = document.getElementById('status-chart');
    const total = (status.pending || 0) + (status.in_progress || 0) + (status.completed || 0);

    if (total === 0) {
        chart.innerHTML = '<p style="color: var(--gray-400); text-align: center; padding: 20px;">No data available</p>';
        return;
    }

    const statuses = [
        { key: 'pending', label: 'Pending', value: status.pending || 0 },
        { key: 'in_progress', label: 'In Progress', value: status.in_progress || 0 },
        { key: 'completed', label: 'Completed', value: status.completed || 0 }
    ];

    chart.innerHTML = statuses.map(s => `
        <div class="status-bar">
            <div class="status-bar-header">
                <span class="status-bar-label">${s.label}</span>
                <span class="status-bar-value">${s.value}</span>
            </div>
            <div class="status-bar-track">
                <div class="status-bar-fill ${s.key}" style="width: ${(s.value / total) * 100}%"></div>
            </div>
        </div>
    `).join('');
}

// Table UX helpers (resizing + sorting)
function enableTableColumnResizing(tableId, storageKey) {
    const table = document.getElementById(tableId);
    if (!table) return;

    const ths = Array.from(table.querySelectorAll('thead th'));
    if (ths.length === 0) return;

    // Apply saved widths
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (Array.isArray(saved) && saved.length === ths.length) {
            ths.forEach((th, i) => {
                if (saved[i]) th.style.width = `${saved[i]}px`;
            });
        }
    } catch {
        // ignore
    }

    ths.forEach((th, i) => {
        // Avoid double-adding resizers
        if (th.querySelector('.col-resizer')) return;
        if (i === ths.length - 1) return;

        const resizer = document.createElement('div');
        resizer.className = 'col-resizer';
        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startWidth = th.getBoundingClientRect().width;

            const onMove = (moveEvent) => {
                const delta = moveEvent.clientX - startX;
                const next = Math.max(90, Math.round(startWidth + delta));
                th.style.width = `${next}px`;
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);

                const widths = ths.map(t => Math.round(t.getBoundingClientRect().width));
                localStorage.setItem(storageKey, JSON.stringify(widths));
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        th.appendChild(resizer);
    });
}

function getApplicationsStageOrder() {
    return ['new', 'emailed', 'replied', 'call_booked', 'purchased', 'onboarding_started', 'onboarding_complete', 'joined'];
}

function getStageLabel(stageKey) {
    return formatDisplayStatus(stageKey, null).text;
}

function compareApplications(a, b) {
    const { key, dir } = applicationsSort || { key: 'created_at', dir: 'desc' };
    const direction = dir === 'asc' ? 1 : -1;

    const value = (app) => {
        switch (key) {
            case 'name':
                return `${app.first_name || ''} ${app.last_name || ''}`.trim().toLowerCase();
            case 'email':
                return (app.email || '').toLowerCase();
            case 'revenue':
                return (app.annual_revenue || '').toLowerCase();
            case 'notes':
                return Number(app.note_count || 0);
            case 'created_at':
            default:
                return new Date(app.created_at || 0).getTime();
        }
    };

    const av = value(a);
    const bv = value(b);
    if (av < bv) return -1 * direction;
    if (av > bv) return 1 * direction;
    return 0;
}

function updateApplicationsSortIndicators() {
    const table = document.getElementById('applications-table');
    if (!table) return;

    const ths = Array.from(table.querySelectorAll('thead th'));
    ths.forEach(th => th.classList.remove('sorted', 'asc', 'desc'));

    const keyToIndex = {
        name: 0,
        email: 1,
        revenue: 2,
        notes: 4,
        created_at: 5
    };

    const index = keyToIndex[applicationsSort?.key];
    if (index == null || !ths[index]) return;

    ths[index].classList.add('sorted', applicationsSort.dir === 'asc' ? 'asc' : 'desc');
}

function setApplicationsSort(nextKey) {
    if (!nextKey) return;

    if (applicationsSort.key === nextKey) {
        applicationsSort.dir = applicationsSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        applicationsSort.key = nextKey;
        applicationsSort.dir = nextKey === 'created_at' ? 'desc' : 'asc';
    }

    localStorage.setItem('admin.applications.sort', JSON.stringify(applicationsSort));
    updateApplicationsSortIndicators();
    renderApplicationsTable();
}

function toggleApplicationsGroup(stageKey) {
    applicationsGroupCollapsed[stageKey] = !applicationsGroupCollapsed[stageKey];
    localStorage.setItem('admin.applications.groupCollapsed', JSON.stringify(applicationsGroupCollapsed));
    renderApplicationsTable();
}

function initApplicationsTableUX() {
    if (applicationsTableUXInitialized) return;
    applicationsTableUXInitialized = true;

    enableTableColumnResizing('applications-table', 'admin.applications.colWidths');

    const table = document.getElementById('applications-table');
    if (!table) return;

    const ths = Array.from(table.querySelectorAll('thead th'));
    const sortableByIndex = new Map([
        [0, 'name'],
        [1, 'email'],
        [2, 'revenue'],
        [4, 'notes'],
        [5, 'created_at']
    ]);

    ths.forEach((th, index) => {
        const sortKey = sortableByIndex.get(index);
        if (!sortKey) return;

        th.classList.add('sortable');
        th.addEventListener('click', (e) => {
            if (e.target.closest('.col-resizer')) return;
            setApplicationsSort(sortKey);
        });
    });

    updateApplicationsSortIndicators();
}

function renderApplicationsTable() {
    const tbody = document.getElementById('applications-tbody');
    if (!tbody) return;
    if (!applicationsLastResponse) return;

    const apps = applicationsLastResponse.applications || [];
    if (apps.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="loading">No applications found</td></tr>';
        return;
    }

    // Group by pipeline stage (display_status)
    const groups = apps.reduce((acc, app) => {
        const stage = app.display_status || 'new';
        (acc[stage] ||= []).push(app);
        return acc;
    }, {});

    const orderedStages = getApplicationsStageOrder();
    const unknownStages = Object.keys(groups).filter(k => !orderedStages.includes(k)).sort();
    const stagesToRender = [...orderedStages, ...unknownStages].filter(k => (groups[k] || []).length > 0);

    const rows = [];

    for (const stageKey of stagesToRender) {
        const stageApps = groups[stageKey] || [];
        const collapsed = !!applicationsGroupCollapsed[stageKey];

        rows.push(`
            <tr class="group-header-row">
                <td colspan="7">
                    <div class="group-row">
                        <button class="group-toggle" type="button" onclick="toggleApplicationsGroup('${stageKey}')">${collapsed ? '▸' : '▾'}</button>
                        <span class="group-color ${stageKey}"></span>
                        <span>${escapeHtml(getStageLabel(stageKey))}</span>
                        <span class="group-count">${stageApps.length}</span>
                    </div>
                </td>
            </tr>
        `);

        if (collapsed) continue;

        const sorted = [...stageApps].sort(compareApplications);
        rows.push(sorted.map(app => {
            const displayStatus = app.display_status || 'new';
            const statusInfo = formatDisplayStatus(displayStatus, app.status_timestamp);
            const noteCount = app.note_count || 0;
            const displayName = `${app.first_name || ''} ${app.last_name || ''}`.trim() || '-';

            return `
                <tr class="clickable-row" onclick="viewApplication('${app.id}')">
                    <td><strong>${escapeHtml(displayName)}</strong></td>
                    <td>${escapeHtml(app.email || '-')}</td>
                    <td>${escapeHtml(app.annual_revenue || '-')}</td>
                    <td>
                        <div class="status-with-time">
                            <span class="status-badge ${displayStatus}">${escapeHtml(statusInfo.text)}</span>
                            ${statusInfo.time ? `<span class="status-time">${escapeHtml(statusInfo.time)}</span>` : ''}
                        </div>
                        <div style="margin-top: 6px;">
                            <select class="inline-status-select app-status ${app.status || 'new'}"
                                    onclick="event.stopPropagation()"
                                    onchange="event.stopPropagation(); this.className = 'inline-status-select app-status ' + this.value; updateApplicationStatus('${app.id}', this.value)">
                                <option value="new" ${app.status === 'new' ? 'selected' : ''}>New</option>
                                <option value="reviewed" ${app.status === 'reviewed' ? 'selected' : ''}>Reviewed</option>
                                <option value="approved" ${app.status === 'approved' ? 'selected' : ''}>Approved</option>
                                <option value="rejected" ${app.status === 'rejected' ? 'selected' : ''}>Rejected</option>
                            </select>
                        </div>
                    </td>
                    <td>
                        <button class="notes-btn ${noteCount > 0 ? 'has-notes' : ''}" onclick="event.stopPropagation(); openNotesPanel('${app.id}')" title="${noteCount > 0 ? noteCount + ' note(s)' : 'Add note'}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                            ${noteCount > 0 ? `<span class="note-count">${noteCount}</span>` : ''}
                        </button>
                    </td>
                    <td>${formatDate(app.created_at)}</td>
                    <td>
                        <div class="kebab-menu">
                            <button class="kebab-btn" onclick="toggleKebabMenu(event, 'app-${app.id}')">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <circle cx="12" cy="5" r="2"/>
                                    <circle cx="12" cy="12" r="2"/>
                                    <circle cx="12" cy="19" r="2"/>
                                </svg>
                            </button>
                            <div class="kebab-dropdown" id="kebab-app-${app.id}">
                                <button class="kebab-dropdown-item" onclick="event.stopPropagation(); viewApplication('${app.id}')">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                    View Data
                                </button>
                                <button class="kebab-dropdown-item danger" onclick="event.stopPropagation(); deleteApplication('${app.id}')">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="3 6 5 6 21 6"/>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                    </svg>
                                    Delete
                                </button>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
        }).join(''));
    }

    tbody.innerHTML = rows.join('');
}

// Applications
async function loadApplications() {
    const tbody = document.getElementById('applications-tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="loading">Loading...</td></tr>';

    try {
        const search = document.getElementById('applications-search')?.value || '';
        const status = document.getElementById('applications-filter')?.value || '';

        const params = new URLSearchParams({
            limit: pageSize,
            offset: applicationsPage * pageSize
        });
        if (search) params.append('search', search);
        if (status) params.append('status', status);

        const data = await fetchAPI(`/applications?${params}`);
        applicationsLastResponse = data;

        initApplicationsTableUX();
        renderApplicationsTable();
        renderPagination('applications', data.total, applicationsPage);
    } catch (error) {
        console.error('Error loading applications:', error);
        tbody.innerHTML = '<tr><td colspan="7" class="loading">Error loading applications</td></tr>';
    }
}

async function viewApplication(id, options = {}) {
    closeAllKebabMenus();
    try {
        const [app, notes] = await Promise.all([
            fetchAPI(`/applications/${id}`),
            loadNotes(id)
        ]);

        const statusInfo = formatDisplayStatus(app.display_status || 'new', app.status_timestamp);

        const title = ([app.first_name, app.last_name].filter(Boolean).join(' ').trim()) || app.email || 'Typeform Application';
        const subtitle = [app.email, statusInfo.text].filter(Boolean).join(' • ');
        const activeTab = options.activeTab || 'overview';

        const overviewHtml = `
            <h4 style="color: var(--orange); margin-bottom: 12px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">Contact Info (Q1-Q5)</h4>
            <div class="detail-row">
                <span class="detail-label">Q1-2: Name</span>
                <span class="detail-value">${app.first_name || ''} ${app.last_name || ''}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Q3: Email</span>
                <span class="detail-value">${app.email || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Q4: Phone</span>
                <span class="detail-value">${app.phone || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Q5: Best Way to Reach</span>
                <span class="detail-value">${app.contact_preference || '-'}</span>
            </div>

            <h4 style="color: var(--orange); margin: 16px 0 12px 0; border-bottom: 1px solid var(--border); padding-bottom: 8px;">Business Info (Q6-Q8)</h4>
            <div class="detail-row">
                <span class="detail-label">Q6: Business Description</span>
                <span class="detail-value">${app.business_description || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Q7: Annual Revenue</span>
                <span class="detail-value">${app.annual_revenue || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Q8: Revenue Trend (3 months)</span>
                <span class="detail-value">${app.revenue_trend || '-'}</span>
            </div>

            <h4 style="color: var(--orange); margin: 16px 0 12px 0; border-bottom: 1px solid var(--border); padding-bottom: 8px;">Goals & Challenges (Q9-Q10)</h4>
            <div class="detail-row">
                <span class="detail-label">Q9: #1 Thing Holding Back</span>
                <span class="detail-value">${app.main_challenge || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Q10: Why CA Pro</span>
                <span class="detail-value">${app.why_ca_pro || '-'}</span>
            </div>

            <h4 style="color: var(--orange); margin: 16px 0 12px 0; border-bottom: 1px solid var(--border); padding-bottom: 8px;">Readiness (Q11-Q13)</h4>
            <div class="detail-row">
                <span class="detail-label">Q11: Investment Readiness</span>
                <span class="detail-value">${app.investment_readiness || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Q12: Decision Timeline</span>
                <span class="detail-value">${app.decision_timeline || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Q13: Has Team</span>
                <span class="detail-value">${app.has_team || '-'}</span>
            </div>

            <h4 style="color: var(--orange); margin: 16px 0 12px 0; border-bottom: 1px solid var(--border); padding-bottom: 8px;">Additional Info (Q14-Q15)</h4>
            <div class="detail-row">
                <span class="detail-label">Q14: Anything Else</span>
                <span class="detail-value">${app.anything_else || app.additional_info || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Q15: How They Heard About CA Pro</span>
                <span class="detail-value">${app.referral_source || '-'}</span>
            </div>

            <h4 style="color: var(--text-secondary); margin: 16px 0 12px 0; border-bottom: 1px solid var(--border); padding-bottom: 8px;">Status</h4>
            <div class="detail-row">
                <span class="detail-label">Progress Status</span>
                <span class="detail-value">
                    <span class="status-badge ${app.display_status || 'new'}">${statusInfo.text}</span>
                    ${statusInfo.time ? `<span style="margin-left: 8px; color: var(--gray-500); font-size: 0.8rem;">${statusInfo.time}</span>` : ''}
                </span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Application Status</span>
                <span class="detail-value">
                    <select class="inline-status-select app-status ${app.status || 'new'}" onchange="event.stopPropagation(); this.className = 'inline-status-select app-status ' + this.value; updateApplicationStatus('${id}', this.value)">
                        <option value="new" ${app.status === 'new' ? 'selected' : ''}>New</option>
                        <option value="reviewed" ${app.status === 'reviewed' ? 'selected' : ''}>Reviewed</option>
                        <option value="approved" ${app.status === 'approved' ? 'selected' : ''}>Approved</option>
                        <option value="rejected" ${app.status === 'rejected' ? 'selected' : ''}>Rejected</option>
                    </select>
                </span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Applied</span>
                <span class="detail-value">${formatDate(app.created_at)}</span>
            </div>
            ${app.emailed_at ? `<div class="detail-row"><span class="detail-label">Emailed</span><span class="detail-value">${formatDate(app.emailed_at)}</span></div>` : ''}
            ${app.replied_at ? `<div class="detail-row"><span class="detail-label">Replied</span><span class="detail-value">${formatDate(app.replied_at)}</span></div>` : ''}
            ${app.call_booked_at ? `<div class="detail-row"><span class="detail-label">Call Booked</span><span class="detail-value">${formatDate(app.call_booked_at)}</span></div>` : ''}
            ${app.onboarding_started_at ? `<div class="detail-row"><span class="detail-label">Chat Started</span><span class="detail-value">${formatDate(app.onboarding_started_at)}</span></div>` : ''}
            ${app.onboarding_completed_at ? `<div class="detail-row"><span class="detail-label">Chat Complete</span><span class="detail-value">${formatDate(app.onboarding_completed_at)}</span></div>` : ''}
            ${app.whatsapp_joined_at ? `<div class="detail-row"><span class="detail-label">WhatsApp Joined</span><span class="detail-value">${formatDate(app.whatsapp_joined_at)}</span></div>` : ''}
        `;

        const notesHtml = `
            ${renderNotesSection(notes, id)}
        `;

        const rawData = app.raw_data || {};
        const rawHtml = `
            <pre style="background: var(--gray-50); padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; border: 1px solid var(--gray-200);">${escapeHtml(JSON.stringify(rawData, null, 2))}</pre>
        `;

        panelState.activeTabId = activeTab;
        openItemPanel({
            title,
            subtitle,
            tabs: [
                { id: 'overview', label: 'Overview', content: overviewHtml },
                { id: 'notes', label: `Notes (${notes.length})`, content: notesHtml },
                { id: 'raw', label: 'Raw', content: rawHtml }
            ],
            footer: `
                <button class="btn btn-secondary btn-sm" type="button" onclick="convertApplication('${id}')">Convert to Member</button>
                <button class="btn btn-secondary btn-sm" type="button" onclick="simulateSubscriptionFailures('${id}')">Simulate Charge Failed</button>
                <button class="btn btn-secondary btn-sm" type="button" onclick="simulateSubscriptionRecovered('${id}')">Simulate Recovered</button>
                <button class="btn btn-secondary btn-sm" type="button" onclick="simulateSubscriptionCancel('${id}')">Simulate Subscription Canceled</button>
                <button class="btn btn-secondary btn-sm" type="button" onclick="runYearlyRenewalsForce()">Run Yearly Renewals (Force)</button>
            `
        });
    } catch (error) {
        showToast('Failed to load application details', 'error');
    }
}

async function updateApplicationStatus(id, status) {
    try {
        await fetchAPI(`/applications/${id}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status })
        });
        showToast(`Application marked as ${status}`, 'success');
        loadApplications();
        loadOverview();
    } catch (error) {
        showToast('Failed to update status', 'error');
    }
}

async function updateMemberOnboardingStatus(id, onboarding_status) {
    try {
        await fetchAPI(`/members/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ onboarding_status })
        });
        showToast(`Member status updated`, 'success');
        loadMembers();
        loadOverview();
    } catch (error) {
        showToast('Failed to update member status', 'error');
    }
}

async function convertApplication(id) {
    try {
        await fetchAPI(`/applications/${id}/convert`, { method: 'POST' });
        showToast('Application approved and converted to member', 'success');
        loadApplications();
        loadOverview();
    } catch (error) {
        showToast(error.message || 'Failed to convert application', 'error');
    }
}

async function simulateSubscriptionFailures(applicationId) {
    const input = prompt('How many failed charges to simulate? (1-4)', '1');
    if (input === null) return;

    const count = Math.max(1, Math.min(parseInt(input, 10) || 1, 4));

    try {
        await fetchAPI(`/applications/${applicationId}/test-subscription-failure`, {
            method: 'POST',
            body: JSON.stringify({ count })
        });
        showToast(`Simulated ${count} failed charge${count === 1 ? '' : 's'}`, 'success');
    } catch (error) {
        showToast(error.message || 'Failed to simulate charge failures', 'error');
    }
}

async function simulateSubscriptionCancel(applicationId) {
    const confirmed = confirm('Simulate a Subscription Canceled event for this member?');
    if (!confirmed) return;

    try {
        await fetchAPI(`/applications/${applicationId}/test-subscription-cancel`, { method: 'POST' });
        showToast('Simulated subscription canceled event', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to simulate subscription cancel', 'error');
    }
}

async function simulateSubscriptionRecovered(applicationId) {
    const confirmed = confirm('Simulate a Subscription Recovered event for this member?');
    if (!confirmed) return;

    try {
        await fetchAPI(`/applications/${applicationId}/test-subscription-recovered`, { method: 'POST' });
        showToast('Simulated subscription recovered event', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to simulate subscription recovered', 'error');
    }
}

async function runYearlyRenewalsForce() {
    const confirmed = confirm('Run yearly renewal notices now (force, outside 9am ET)?');
    if (!confirmed) return;

    try {
        await fetchAPI('/jobs/process-yearly-renewals/force', { method: 'POST' });
        showToast('Yearly renewal job started', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to run yearly renewals', 'error');
    }
}

// Members board helpers
function getMembersStatusOrder() {
    return ['pending', 'in_progress', 'completed'];
}

function getMemberStatusLabel(statusKey) {
    if (statusKey === 'in_progress') return 'In Progress';
    if (statusKey === 'completed') return 'Completed';
    return 'Pending';
}

function compareMembers(a, b) {
    const { key, dir } = membersSort || { key: 'created_at', dir: 'desc' };
    const direction = dir === 'asc' ? 1 : -1;

    const value = (m) => {
        switch (key) {
            case 'name':
                return `${m.first_name || ''} ${m.last_name || ''}`.trim().toLowerCase();
            case 'business':
                return (m.business_name || '').toLowerCase();
            case 'email':
                return (m.email || '').toLowerCase();
            case 'revenue':
                return (m.annual_revenue || '').toLowerCase();
            case 'team':
                return Number(m.team_member_count || 0);
            case 'created_at':
            default:
                return new Date(m.created_at || 0).getTime();
        }
    };

    const av = value(a);
    const bv = value(b);
    if (av < bv) return -1 * direction;
    if (av > bv) return 1 * direction;
    return 0;
}

function updateMembersSortIndicators() {
    const table = document.getElementById('members-table');
    if (!table) return;

    const ths = Array.from(table.querySelectorAll('thead th'));
    ths.forEach(th => th.classList.remove('sorted', 'asc', 'desc'));

    const keyToIndex = {
        name: 0,
        business: 1,
        email: 2,
        revenue: 3,
        team: 4,
        created_at: null
    };

    const index = keyToIndex[membersSort?.key];
    if (index == null || !ths[index]) return;
    ths[index].classList.add('sorted', membersSort.dir === 'asc' ? 'asc' : 'desc');
}

function setMembersSort(nextKey) {
    if (!nextKey) return;

    if (membersSort.key === nextKey) {
        membersSort.dir = membersSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        membersSort.key = nextKey;
        membersSort.dir = nextKey === 'team' ? 'desc' : (nextKey === 'created_at' ? 'desc' : 'asc');
    }

    localStorage.setItem('admin.members.sort', JSON.stringify(membersSort));
    updateMembersSortIndicators();
    renderMembersTable();
}

function toggleMembersGroup(statusKey) {
    membersGroupCollapsed[statusKey] = !membersGroupCollapsed[statusKey];
    localStorage.setItem('admin.members.groupCollapsed', JSON.stringify(membersGroupCollapsed));
    renderMembersTable();
}

function initMembersTableUX() {
    if (membersTableUXInitialized) return;
    membersTableUXInitialized = true;

    enableTableColumnResizing('members-table', 'admin.members.colWidths');

    const table = document.getElementById('members-table');
    if (!table) return;

    const ths = Array.from(table.querySelectorAll('thead th'));
    const sortableByIndex = new Map([
        [0, 'name'],
        [1, 'business'],
        [2, 'email'],
        [3, 'revenue'],
        [4, 'team']
    ]);

    ths.forEach((th, index) => {
        const sortKey = sortableByIndex.get(index);
        if (!sortKey) return;

        th.classList.add('sortable');
        th.addEventListener('click', (e) => {
            if (e.target.closest('.col-resizer')) return;
            setMembersSort(sortKey);
        });
    });

    updateMembersSortIndicators();
}

function renderMembersTable() {
    const tbody = document.getElementById('members-tbody');
    if (!tbody) return;
    if (!membersLastResponse) return;

    const members = membersLastResponse.members || [];
    if (members.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="loading">No members found</td></tr>';
        return;
    }

    const groups = members.reduce((acc, m) => {
        const status = m.onboarding_status || 'pending';
        (acc[status] ||= []).push(m);
        return acc;
    }, {});

    const ordered = getMembersStatusOrder();
    const unknown = Object.keys(groups).filter(k => !ordered.includes(k)).sort();
    const statusesToRender = [...ordered, ...unknown].filter(k => (groups[k] || []).length > 0);

    const rows = [];

    for (const statusKey of statusesToRender) {
        const groupMembers = groups[statusKey] || [];
        const collapsed = !!membersGroupCollapsed[statusKey];

        rows.push(`
            <tr class="group-header-row">
                <td colspan="7">
                    <div class="group-row">
                        <button class="group-toggle" type="button" onclick="toggleMembersGroup('${statusKey}')">${collapsed ? '▸' : '▾'}</button>
                        <span class="group-color ${statusKey}"></span>
                        <span>${escapeHtml(getMemberStatusLabel(statusKey))}</span>
                        <span class="group-count">${groupMembers.length}</span>
                    </div>
                </td>
            </tr>
        `);

        if (collapsed) continue;

        const sorted = [...groupMembers].sort(compareMembers);
        rows.push(sorted.map(member => {
            const name = `${member.first_name || ''} ${member.last_name || ''}`.trim() || '-';
            const business = member.business_name || '-';
            const email = member.email || '-';
            const revenue = member.annual_revenue || '-';
            const teamCount = Number(member.team_member_count || 0);
            const status = member.onboarding_status || 'pending';

            return `
                <tr class="clickable-row" onclick="viewMember('${member.id}')">
                    <td><strong>${escapeHtml(name)}</strong></td>
                    <td>${escapeHtml(business)}</td>
                    <td>${escapeHtml(email)}</td>
                    <td>${escapeHtml(revenue)}</td>
                    <td>${teamCount}</td>
                    <td>
                        <select class="inline-status-select member-status ${status}"
                                onclick="event.stopPropagation()"
                                onchange="event.stopPropagation(); this.className = 'inline-status-select member-status ' + this.value; updateMemberOnboardingStatus('${member.id}', this.value)">
                            <option value="pending" ${status === 'pending' ? 'selected' : ''}>Pending</option>
                            <option value="in_progress" ${status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                            <option value="completed" ${status === 'completed' ? 'selected' : ''}>Completed</option>
                        </select>
                    </td>
                    <td>
                        <div class="kebab-menu">
                            <button class="kebab-btn" onclick="toggleKebabMenu(event, 'member-${member.id}')">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <circle cx="12" cy="5" r="2"/>
                                    <circle cx="12" cy="12" r="2"/>
                                    <circle cx="12" cy="19" r="2"/>
                                </svg>
                            </button>
                            <div class="kebab-dropdown" id="kebab-member-${member.id}">
                                <button class="kebab-dropdown-item" onclick="event.stopPropagation(); viewMember('${member.id}')">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                    View Data
                                </button>
                                <button class="kebab-dropdown-item danger" onclick="event.stopPropagation(); deleteMember('${member.id}')">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="3 6 5 6 21 6"/>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                    </svg>
                                    Delete
                                </button>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
        }).join(''));
    }

    tbody.innerHTML = rows.join('');
}

// Members
async function loadMembers() {
    const tbody = document.getElementById('members-tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="loading">Loading...</td></tr>';

    try {
        initMembersTableUX();

        const search = document.getElementById('members-search')?.value || '';
        const source = document.getElementById('members-source-filter')?.value || '';
        const status = document.getElementById('members-status-filter')?.value || '';

        const params = new URLSearchParams({
            limit: pageSize,
            offset: membersPage * pageSize
        });
        if (search) params.append('search', search);
        if (source) params.append('source', source);
        if (status) params.append('status', status);

        const data = await fetchAPI(`/members?${params}`);
        membersLastResponse = data;
        renderMembersTable();
        renderPagination('members', data.total, membersPage);
    } catch (error) {
        console.error('Error loading members:', error);
        tbody.innerHTML = '<tr><td colspan="7" class="loading">Error loading members</td></tr>';
    }
}

async function viewMember(id) {
    closeAllKebabMenus();
    try {
        // Use unified endpoint to get all linked data
        const member = await fetchAPI(`/members/${id}/unified`);

        // Team members section
        let teamHtml = '';
        if (member.team_members && member.team_members.length > 0) {
            teamHtml = `
                <h4 style="margin-top: 20px; margin-bottom: 12px; font-size: 0.9rem; color: var(--gray-600);">👥 Team Members</h4>
                ${member.team_members.map(tm => `
                    <div style="background: var(--gray-50); padding: 10px; border-radius: 6px; margin-bottom: 8px;">
                        <strong>${tm.first_name} ${tm.last_name}</strong> - ${tm.role || tm.title || 'N/A'}<br>
                        <small style="color: var(--gray-500);">${tm.email}</small>
                    </div>
                `).join('')}
            `;
        }

        // Linked Typeform data section
        let typeformHtml = '';
        if (member.typeform_application) {
            const tf = member.typeform_application;
            typeformHtml = `
                <h4 style="margin-top: 20px; margin-bottom: 12px; font-size: 0.9rem; color: var(--blue);">📝 Linked Typeform Application</h4>
                <div style="background: #dbeafe; padding: 12px; border-radius: 8px; font-size: 0.85rem;">
                    <div><strong>Business:</strong> ${tf.business_description || '-'}</div>
                    <div><strong>Revenue:</strong> ${tf.annual_revenue || '-'}</div>
                    <div><strong>Challenge:</strong> ${tf.main_challenge || '-'}</div>
                    <div><strong>Why CA Pro:</strong> ${tf.why_ca_pro || '-'}</div>
                    <div style="margin-top: 8px; color: var(--gray-500); font-size: 0.8rem;">Applied: ${formatDate(tf.created_at)}</div>
                </div>
            `;
        }

        // Linked SamCart data section
        let samcartHtml = '';
        if (member.samcart_order) {
            const sc = member.samcart_order;
            samcartHtml = `
                <h4 style="margin-top: 20px; margin-bottom: 12px; font-size: 0.9rem; color: var(--green);">💳 Linked SamCart Order</h4>
                <div style="background: #d1fae5; padding: 12px; border-radius: 8px; font-size: 0.85rem;">
                    <div><strong>Product:</strong> ${sc.product_name || '-'}</div>
                    <div><strong>Amount:</strong> ${sc.order_total ? `$${sc.order_total}` : '-'}</div>
                    <div><strong>Status:</strong> ${sc.status || '-'}</div>
                    <div style="margin-top: 8px; color: var(--gray-500); font-size: 0.8rem;">Purchased: ${formatDate(sc.created_at)}</div>
                </div>
            `;
        }

        const memberTitle = ([member.first_name, member.last_name].filter(Boolean).join(' ').trim()) || member.email || 'Member';
        const memberSubtitle = member.email || '';

        openItemPanel({
            title: memberTitle,
            subtitle: memberSubtitle,
            content: `
            <div class="detail-row">
                <span class="detail-label">Business</span>
                <span class="detail-value">${member.business_name || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Email</span>
                <span class="detail-value">${member.email || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Phone</span>
                <span class="detail-value">${member.phone || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Revenue</span>
                <span class="detail-value">${member.annual_revenue || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Team Count</span>
                <span class="detail-value">${member.team_count || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">AI Skill Level</span>
                <span class="detail-value">${member.ai_skill_level ? `${member.ai_skill_level}/10` : '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Traffic Sources</span>
                <span class="detail-value">${member.traffic_sources || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Landing Pages</span>
                <span class="detail-value">${formatLinks(member.landing_pages)}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Pain Point</span>
                <span class="detail-value">${member.pain_point || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Massive Win</span>
                <span class="detail-value">${member.massive_win || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Bio</span>
                <span class="detail-value">${member.bio || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">WhatsApp</span>
                <span class="detail-value">${member.whatsapp_number || '-'} ${member.whatsapp_joined ? '(joined)' : ''}</span>
            </div>
            ${member.whatsapp_joined_at ? `<div class="detail-row"><span class="detail-label">WhatsApp Joined</span><span class="detail-value">${formatDate(member.whatsapp_joined_at)}</span></div>` : ''}
            <div class="detail-row">
                <span class="detail-label">Source</span>
                <span class="detail-value">${member.source?.replace('_', ' ') || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Status</span>
                <span class="detail-value">
                    <select class="inline-status-select member-status ${member.onboarding_status || 'pending'}" onchange="event.stopPropagation(); this.className = 'inline-status-select member-status ' + this.value; updateMemberOnboardingStatus('${member.id}', this.value)">
                        <option value="pending" ${member.onboarding_status === 'pending' ? 'selected' : ''}>Pending</option>
                        <option value="in_progress" ${member.onboarding_status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                        <option value="completed" ${member.onboarding_status === 'completed' ? 'selected' : ''}>Completed</option>
                    </select>
                </span>
            </div>
            ${typeformHtml}
            ${samcartHtml}
            ${teamHtml}
            `
        });
    } catch (error) {
        showToast('Failed to load member details', 'error');
    }
}

// Team Members board helpers
function hashStringToInt(input) {
    const str = (input || '').toString();
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0; // 32-bit
    }
    return Math.abs(hash);
}

function pickGroupColor(label) {
    const palette = [
        '#0073ea', // blue
        '#00c875', // green
        '#ffcb00', // yellow
        '#e2445c', // red
        '#a25ddc', // purple
        '#00a9ff', // light blue
        '#ff642e', // orange
        '#579bfc'  // azure
    ];
    const idx = hashStringToInt(label) % palette.length;
    return palette[idx];
}

function compareTeamMembers(a, b) {
    const { key, dir } = teamMembersSort || { key: 'created_at', dir: 'desc' };
    const direction = dir === 'asc' ? 1 : -1;

    const value = (tm) => {
        switch (key) {
            case 'name':
                return `${tm.first_name || ''} ${tm.last_name || ''}`.trim().toLowerCase();
            case 'email':
                return (tm.email || '').toLowerCase();
            case 'role':
                return (tm.role || tm.title || '').toLowerCase();
            case 'company':
                return (tm.business_name || '').toLowerCase();
            case 'created_at':
            default:
                return new Date(tm.created_at || 0).getTime();
        }
    };

    const av = value(a);
    const bv = value(b);
    if (av < bv) return -1 * direction;
    if (av > bv) return 1 * direction;
    return 0;
}

function updateTeamMembersSortIndicators() {
    const table = document.getElementById('team-members-table');
    if (!table) return;

    const ths = Array.from(table.querySelectorAll('thead th'));
    ths.forEach(th => th.classList.remove('sorted', 'asc', 'desc'));

    const keyToIndex = {
        name: 0,
        email: 1,
        role: 2,
        company: 3,
        created_at: null
    };

    const index = keyToIndex[teamMembersSort?.key];
    if (index == null || !ths[index]) return;
    ths[index].classList.add('sorted', teamMembersSort.dir === 'asc' ? 'asc' : 'desc');
}

function setTeamMembersSort(nextKey) {
    if (!nextKey) return;

    if (teamMembersSort.key === nextKey) {
        teamMembersSort.dir = teamMembersSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        teamMembersSort.key = nextKey;
        teamMembersSort.dir = nextKey === 'created_at' ? 'desc' : 'asc';
    }

    localStorage.setItem('admin.teamMembers.sort', JSON.stringify(teamMembersSort));
    updateTeamMembersSortIndicators();
    renderTeamMembersTable();
}

function toggleTeamMembersGroup(encodedGroupKey) {
    const groupKey = decodeURIComponent(encodedGroupKey || '');
    teamMembersGroupCollapsed[groupKey] = !teamMembersGroupCollapsed[groupKey];
    localStorage.setItem('admin.teamMembers.groupCollapsed', JSON.stringify(teamMembersGroupCollapsed));
    renderTeamMembersTable();
}

function initTeamMembersTableUX() {
    if (teamMembersTableUXInitialized) return;
    teamMembersTableUXInitialized = true;

    enableTableColumnResizing('team-members-table', 'admin.teamMembers.colWidths');

    const table = document.getElementById('team-members-table');
    if (!table) return;

    const ths = Array.from(table.querySelectorAll('thead th'));
    const sortableByIndex = new Map([
        [0, 'name'],
        [1, 'email'],
        [2, 'role'],
        [3, 'company']
    ]);

    ths.forEach((th, index) => {
        const sortKey = sortableByIndex.get(index);
        if (!sortKey) return;

        th.classList.add('sortable');
        th.addEventListener('click', (e) => {
            if (e.target.closest('.col-resizer')) return;
            setTeamMembersSort(sortKey);
        });
    });

    updateTeamMembersSortIndicators();
}

function renderTeamMembersTable() {
    const tbody = document.getElementById('team-members-tbody');
    if (!tbody) return;
    if (!teamMembersLastResponse) return;

    const members = teamMembersLastResponse.team_members || [];
    if (members.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="loading">No team members found</td></tr>';
        return;
    }

    const groups = members.reduce((acc, tm) => {
        const company = (tm.business_name || '').trim() || 'No Company';
        (acc[company] ||= []).push(tm);
        return acc;
    }, {});

    const groupNames = Object.keys(groups).sort((a, b) => {
        if (a === 'No Company') return -1;
        if (b === 'No Company') return 1;
        return a.localeCompare(b);
    });

    const rows = [];

    for (const company of groupNames) {
        const groupMembers = groups[company] || [];
        const collapsed = !!teamMembersGroupCollapsed[company];
        const color = pickGroupColor(company);

        rows.push(`
            <tr class="group-header-row">
                <td colspan="6">
                    <div class="group-row">
                        <button class="group-toggle" type="button" onclick="toggleTeamMembersGroup('${encodeURIComponent(company)}')">${collapsed ? '▸' : '▾'}</button>
                        <span class="group-color" style="background: ${color};"></span>
                        <span>${escapeHtml(company)}</span>
                        <span class="group-count">${groupMembers.length}</span>
                    </div>
                </td>
            </tr>
        `);

        if (collapsed) continue;

        const sorted = [...groupMembers].sort(compareTeamMembers);
        rows.push(sorted.map(tm => {
            const name = `${tm.first_name || ''} ${tm.last_name || ''}`.trim() || '-';
            const role = tm.role || tm.title || '-';
            const companyName = tm.business_name || '-';

            return `
                <tr class="clickable-row" onclick="viewTeamMember('${tm.id}')">
                    <td><strong>${escapeHtml(name)}</strong></td>
                    <td>${escapeHtml(tm.email || '-')}</td>
                    <td>${escapeHtml(role)}</td>
                    <td>${escapeHtml(companyName)}</td>
                    <td>
                        <div class="skills-display">
                            ${tm.copywriting_skill ? `<span class="skill-badge">Copy: ${tm.copywriting_skill}</span>` : ''}
                            ${tm.cro_skill ? `<span class="skill-badge">CRO: ${tm.cro_skill}</span>` : ''}
                            ${tm.ai_skill ? `<span class="skill-badge">AI: ${tm.ai_skill}</span>` : ''}
                        </div>
                    </td>
                    <td>
                        <div class="kebab-menu">
                            <button class="kebab-btn" onclick="toggleKebabMenu(event, 'tm-${tm.id}')">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <circle cx="12" cy="5" r="2"/>
                                    <circle cx="12" cy="12" r="2"/>
                                    <circle cx="12" cy="19" r="2"/>
                                </svg>
                            </button>
                            <div class="kebab-dropdown" id="kebab-tm-${tm.id}">
                                <button class="kebab-dropdown-item" onclick="event.stopPropagation(); viewTeamMember('${tm.id}')">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                    View Data
                                </button>
                                <button class="kebab-dropdown-item danger" onclick="event.stopPropagation(); deleteTeamMember('${tm.id}')">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="3 6 5 6 21 6"/>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                    </svg>
                                    Delete
                                </button>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
        }).join(''));
    }

    tbody.innerHTML = rows.join('');
}

// Team Members
async function loadTeamMembers() {
    const tbody = document.getElementById('team-members-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading">Loading...</td></tr>';

    try {
        initTeamMembersTableUX();

        const search = document.getElementById('team-members-search')?.value || '';

        const params = new URLSearchParams({
            limit: pageSize,
            offset: teamMembersPage * pageSize
        });
        if (search) params.append('search', search);

        const data = await fetchAPI(`/team-members?${params}`);
        teamMembersLastResponse = data;
        renderTeamMembersTable();
        renderPagination('team-members', Number(data.total || 0), teamMembersPage);
    } catch (error) {
        console.error('Error loading team members:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="loading">Error loading team members</td></tr>';
    }
}

// Cancellations
async function loadCancellations() {
    const tbody = document.getElementById('cancellations-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="loading">Loading...</td></tr>';

    try {
        const search = document.getElementById('cancellations-search')?.value || '';

        const params = new URLSearchParams({
            limit: pageSize,
            offset: cancellationsPage * pageSize
        });
        if (search) params.append('search', search);

        const data = await fetchAPI(`/cancellations?${params}`);
        renderCancellationsTable(data.cancellations || []);
        renderPagination('cancellations', data.total || 0, cancellationsPage);
    } catch (error) {
        console.error('Error loading cancellations:', error);
        tbody.innerHTML = '<tr><td colspan="5" class="loading">Error loading cancellations</td></tr>';
    }
}

function renderCancellationsTable(rows) {
    const tbody = document.getElementById('cancellations-tbody');
    if (!tbody) return;

    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading">No cancellations found</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(item => `
        <tr>
            <td>${escapeHtml(item.member_name || '-')}</td>
            <td>${escapeHtml(item.member_email || '-')}</td>
            <td>${escapeHtml(item.reason || '-')}</td>
            <td>${escapeHtml(item.source || '-')}</td>
            <td>${formatDate(item.created_at)}</td>
        </tr>
    `).join('');
}

async function viewTeamMember(id) {
    try {
        const tm = await fetchAPI(`/team-members/${id}`);
        const title = ([tm.first_name, tm.last_name].filter(Boolean).join(' ').trim()) || tm.email || 'Team Member';
        const subtitle = tm.email || '';

        openItemPanel({
            title,
            subtitle,
            content: `
            <div class="detail-row">
                <span class="detail-label">Email</span>
                <span class="detail-value">${tm.email || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Phone</span>
                <span class="detail-value">${tm.phone || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Role/Title</span>
                <span class="detail-value">${tm.role || tm.title || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Company</span>
                <span class="detail-value">${tm.business_name || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Business Owner</span>
                <span class="detail-value">${tm.owner_first_name && tm.owner_last_name ? `${tm.owner_first_name} ${tm.owner_last_name}` : '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Business Summary</span>
                <span class="detail-value">${tm.business_summary || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Responsibilities</span>
                <span class="detail-value">${tm.responsibilities || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Copywriting Skill</span>
                <span class="detail-value">${tm.copywriting_skill ? `${tm.copywriting_skill}/10` : '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">CRO Skill</span>
                <span class="detail-value">${tm.cro_skill ? `${tm.cro_skill}/10` : '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">AI Skill</span>
                <span class="detail-value">${tm.ai_skill ? `${tm.ai_skill}/10` : '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Source</span>
                <span class="detail-value">${tm.source?.replace('_', ' ') || '-'}</span>
            </div>
            `
        });
    } catch (error) {
        showToast('Failed to load team member details', 'error');
    }
}

// Onboarding
async function loadOnboarding() {
    const statsDiv = document.getElementById('onboarding-stats');
    const tbody = document.getElementById('submissions-tbody');

    try {
        enableTableColumnResizing('submissions-table', 'admin.submissions.colWidths');

        // Get filter values
        const search = document.getElementById('submissions-search')?.value || '';
        const completeFilter = document.getElementById('submissions-filter')?.value || '';

        // Build query params
        const params = new URLSearchParams({ limit: 50 });
        if (search) params.append('search', search);
        if (completeFilter !== '') params.append('complete', completeFilter);

        const [status, submissions] = await Promise.all([
            fetchAPI('/onboarding/status'),
            fetchAPI(`/onboarding/submissions?${params}`)
        ]);

        // Render stats - show both member status and submission counts
        const memberStatus = status.member_status || {};
        const subCounts = status.submissions || submissions.counts || {};

        statsDiv.innerHTML = `
            <div class="onboarding-stat pending">
                <div class="onboarding-stat-value">${memberStatus.pending || 0}</div>
                <div class="onboarding-stat-label">Members Pending</div>
            </div>
            <div class="onboarding-stat in-progress">
                <div class="onboarding-stat-value">${subCounts.incomplete || 0}</div>
                <div class="onboarding-stat-label">Incomplete Submissions</div>
            </div>
            <div class="onboarding-stat completed">
                <div class="onboarding-stat-value">${subCounts.complete || 0}</div>
                <div class="onboarding-stat-label">Complete Submissions</div>
            </div>
        `;

        // Render submissions with progress info
        if (submissions.submissions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="loading">No submissions found</td></tr>';
        } else {
            tbody.innerHTML = submissions.submissions.map(sub => {
                const progress = sub.progress_percentage || 0;
                const isComplete = sub.is_complete;
                const sessionShort = sub.session_id ? sub.session_id.substring(0, 16) + '...' : '-';
                const statusClass = isComplete ? 'completed' : 'pending';
                const statusText = isComplete ? 'Complete' : 'Incomplete';

                // Show name if matched to business owner, otherwise show session ID
                const memberName = [sub.first_name, sub.last_name].filter(Boolean).join(' ');
                const displayName = memberName || sessionShort;
                const displayTitle = memberName ? `${memberName} (${sub.session_id || ''})` : (sub.session_id || '');

                return `
                <tr class="clickable-row" onclick="viewSubmission('${sub.id}')">
                    <td title="${displayTitle}">${displayName}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div style="flex: 1; height: 8px; background: var(--gray-200); border-radius: 4px; overflow: hidden;">
                                <div style="height: 100%; width: ${progress}%; background: ${isComplete ? 'var(--green)' : 'var(--yellow)'}; border-radius: 4px;"></div>
                            </div>
                            <span style="font-size: 0.8rem; color: var(--gray-500);">${progress}%</span>
                        </div>
                    </td>
                    <td>${sub.last_question || '-'}</td>
                    <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                    <td>${formatDate(sub.updated_at || sub.created_at)}</td>
                    <td>
                        <div class="kebab-menu">
                            <button class="kebab-btn" onclick="toggleKebabMenu(event, '${sub.id}')">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <circle cx="12" cy="5" r="2"/>
                                    <circle cx="12" cy="12" r="2"/>
                                    <circle cx="12" cy="19" r="2"/>
                                </svg>
                            </button>
                            <div class="kebab-dropdown" id="kebab-${sub.id}">
                                <button class="kebab-dropdown-item" onclick="event.stopPropagation(); viewSubmission('${sub.id}')">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                    View Data
                                </button>
                                <button class="kebab-dropdown-item success" onclick="event.stopPropagation(); markSubmissionComplete('${sub.id}')">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="20 6 9 17 4 12"/>
                                    </svg>
                                    Mark Complete
                                </button>
                                <button class="kebab-dropdown-item danger" onclick="event.stopPropagation(); deleteSubmission('${sub.id}')">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="3 6 5 6 21 6"/>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                    </svg>
                                    Delete
                                </button>
                            </div>
                        </div>
                    </td>
                </tr>
            `}).join('');
        }
    } catch (error) {
        console.error('Error loading onboarding:', error);
        statsDiv.innerHTML = '<p class="loading">Error loading data</p>';
    }
}

async function viewSubmission(id) {
    closeAllKebabMenus();
    try {
        const sub = await fetchAPI(`/onboarding/submissions/${id}`);
        const data = sub.data || {};

        const title = 'Submission';
        const subtitle = sub.updated_at ? `Updated ${formatDate(sub.updated_at)}` : (sub.created_at ? `Created ${formatDate(sub.created_at)}` : '');

        openItemPanel({
            title,
            subtitle,
            content: `
                <pre style="background: var(--gray-50); padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; border: 1px solid var(--gray-200);">${escapeHtml(JSON.stringify(data, null, 2))}</pre>
            `
        });
    } catch (error) {
        showToast('Failed to load submission data', 'error');
    }
}

// Kebab menu functions
function toggleKebabMenu(event, id) {
    event.stopPropagation();
    const dropdown = document.getElementById(`kebab-${id}`);
    const button = event.currentTarget;
    const isActive = dropdown.classList.contains('active');

    // Close all other menus
    closeAllKebabMenus();

    // Toggle this menu
    if (!isActive) {
        // Position the dropdown using fixed positioning
        const rect = button.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.right = `${window.innerWidth - rect.right}px`;
        dropdown.style.left = 'auto';
        dropdown.classList.add('active');
    }
}

function closeAllKebabMenus() {
    document.querySelectorAll('.kebab-dropdown').forEach(menu => {
        menu.classList.remove('active');
    });
}

// Close kebab menu when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.kebab-menu')) {
        closeAllKebabMenus();
    }
});

async function markSubmissionComplete(id) {
    closeAllKebabMenus();
    try {
        await fetchAPI(`/onboarding/submissions/${id}/complete`, { method: 'POST' });
        showToast('Submission marked as complete and moved to Members', 'success');
        loadOnboarding();
        loadOverview();
    } catch (error) {
        showToast(error.message || 'Failed to mark as complete', 'error');
    }
}

async function deleteSubmission(id) {
    closeAllKebabMenus();
    if (!confirm('Are you sure you want to delete this submission? This action cannot be undone.')) {
        return;
    }

    try {
        await fetchAPI(`/onboarding/submissions/${id}`, { method: 'DELETE' });
        showToast('Submission deleted', 'success');
        loadOnboarding();
    } catch (error) {
        showToast(error.message || 'Failed to delete submission', 'error');
    }
}

// Import
function setupImport() {
    setupUploadArea('bo-upload-area', 'bo-file-input', 'business-owners', 'bo-import-result');
    setupUploadArea('tm-upload-area', 'tm-file-input', 'team-members', 'tm-import-result');
}

function setupUploadArea(areaId, inputId, importType, resultId) {
    const area = document.getElementById(areaId);
    const input = document.getElementById(inputId);
    const result = document.getElementById(resultId);

    if (!area || !input) return;

    area.addEventListener('click', () => input.click());

    area.addEventListener('dragover', (e) => {
        e.preventDefault();
        area.classList.add('dragover');
    });

    area.addEventListener('dragleave', () => {
        area.classList.remove('dragover');
    });

    area.addEventListener('drop', (e) => {
        e.preventDefault();
        area.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) handleFileUpload(file, importType, result);
    });

    input.addEventListener('change', () => {
        const file = input.files[0];
        if (file) handleFileUpload(file, importType, result);
        input.value = '';
    });
}

async function handleFileUpload(file, importType, resultEl) {
    if (!file.name.endsWith('.csv')) {
        showToast('Please upload a CSV file', 'error');
        return;
    }

    resultEl.className = 'import-result';
    resultEl.style.display = 'none';

    const formData = new FormData();
    formData.append('file', file);

    try {
        showToast('Importing...', 'warning');

        const response = await fetch(`${API_BASE}/import/${importType}`, {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Import failed');
        }

        resultEl.className = 'import-result success';
        resultEl.textContent = `Imported ${data.imported} records. ${data.failed} failed.`;
        resultEl.style.display = 'block';

        showToast(`Import complete: ${data.imported} records imported`, 'success');
        loadImportHistory();
        loadOverview();
    } catch (error) {
        resultEl.className = 'import-result error';
        resultEl.textContent = error.message;
        resultEl.style.display = 'block';
        showToast('Import failed: ' + error.message, 'error');
    }
}

async function loadImportHistory() {
    const tbody = document.getElementById('import-history-tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="loading">Loading...</td></tr>';

    try {
        enableTableColumnResizing('import-history-table', 'admin.importHistory.colWidths');

        const data = await fetchAPI('/import/history');

        if (data.imports.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="loading">No import history</td></tr>';
        } else {
            tbody.innerHTML = data.imports.map(imp => `
                <tr>
                    <td>${imp.filename || '-'}</td>
                    <td>${imp.import_type?.replace('_', ' ') || '-'}</td>
                    <td>${imp.records_imported || 0}</td>
                    <td>${imp.records_failed || 0}</td>
                    <td>${formatDate(imp.created_at)}</td>
                </tr>
            `).join('');
        }
    } catch (error) {
        console.error('Error loading import history:', error);
        tbody.innerHTML = '<tr><td colspan="5" class="loading">Error loading history</td></tr>';
    }
}

// Pagination
function renderPagination(type, total, currentPage) {
    const container = document.getElementById(`${type}-pagination`);
    if (!container) return;

    const totalPages = Math.ceil(total / pageSize);

    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    let html = '';

    html += `<button onclick="changePage('${type}', ${currentPage - 1})" ${currentPage === 0 ? 'disabled' : ''}>Prev</button>`;

    const startPage = Math.max(0, currentPage - 2);
    const endPage = Math.min(totalPages - 1, currentPage + 2);

    if (startPage > 0) {
        html += `<button onclick="changePage('${type}', 0)">1</button>`;
        if (startPage > 1) html += '<span>...</span>';
    }

    for (let i = startPage; i <= endPage; i++) {
        html += `<button onclick="changePage('${type}', ${i})" class="${i === currentPage ? 'active' : ''}">${i + 1}</button>`;
    }

    if (endPage < totalPages - 1) {
        if (endPage < totalPages - 2) html += '<span>...</span>';
        html += `<button onclick="changePage('${type}', ${totalPages - 1})">${totalPages}</button>`;
    }

    html += `<button onclick="changePage('${type}', ${currentPage + 1})" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>Next</button>`;

    container.innerHTML = html;
}

function changePage(type, page) {
    if (page < 0) return;

    switch (type) {
        case 'applications':
            applicationsPage = page;
            loadApplications();
            break;
        case 'members':
            membersPage = page;
            loadMembers();
            break;
        case 'team-members':
            teamMembersPage = page;
            loadTeamMembers();
            break;
        case 'cancellations':
            cancellationsPage = page;
            loadCancellations();
            break;
    }
}

// Right-side Item Panel (Monday-style)
const panelState = {
    tabs: [],
    activeTabId: null
};

function renderPanelTabs(tabs, activeTabId) {
    const tabsEl = document.getElementById('item-panel-tabs');
    if (!tabs || tabs.length === 0) {
        tabsEl.innerHTML = '';
        tabsEl.style.display = 'none';
        return;
    }

    tabsEl.style.display = 'flex';
    tabsEl.innerHTML = tabs.map(t => `
        <button class="panel-tab ${t.id === activeTabId ? 'active' : ''}" type="button" onclick="setActivePanelTab('${t.id}')">
            ${escapeHtml(t.label)}
        </button>
    `).join('');
}

function setActivePanelTab(tabId) {
    if (!panelState.tabs || panelState.tabs.length === 0) return;

    const tab = panelState.tabs.find(t => t.id === tabId);
    if (!tab) return;

    panelState.activeTabId = tabId;

    // Update tab active state + body
    renderPanelTabs(panelState.tabs, panelState.activeTabId);
    document.getElementById('item-panel-body').innerHTML = tab.content || '';
}

function openItemPanel({ title, subtitle = '', tabs = null, content = '', footer = '' }) {
    const overlay = document.getElementById('item-panel-overlay');
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');

    document.getElementById('item-panel-title').textContent = title || 'Details';
    document.getElementById('item-panel-subtitle').textContent = subtitle || '';
    document.getElementById('item-panel-footer').innerHTML = footer || '';

    if (tabs && tabs.length > 0) {
        panelState.tabs = tabs;
        panelState.activeTabId = tabs.find(t => t.id === panelState.activeTabId)?.id || tabs[0].id;
        renderPanelTabs(panelState.tabs, panelState.activeTabId);
        const active = panelState.tabs.find(t => t.id === panelState.activeTabId) || panelState.tabs[0];
        document.getElementById('item-panel-body').innerHTML = active.content || '';
        return;
    }

    panelState.tabs = [];
    panelState.activeTabId = null;
    renderPanelTabs([], null);
    document.getElementById('item-panel-body').innerHTML = content || '';
}

function closeItemPanel() {
    const overlay = document.getElementById('item-panel-overlay');
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    panelState.tabs = [];
    panelState.activeTabId = null;
}

// Keep legacy modal API but route it into the right-side panel
function openModal(title, content) {
    openItemPanel({ title, content });
}

function closeModal() {
    closeItemPanel();
}

document.getElementById('item-panel-close')?.addEventListener('click', () => closeItemPanel());
document.getElementById('item-panel-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeItemPanel();
});

// Close panel (and legacy modal) on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeItemPanel();
});

// Toast
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 4000);
}

// Utility functions
async function fetchAPI(endpoint, options = {}) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'API request failed');
    }

    return data;
}

function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

function formatTimeAgo(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return formatDate(dateString);
}

function formatLinks(text) {
    if (!text) return '-';
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, '<a href="$1" target="_blank">$1</a>');
}

// Format display status with timestamp
function formatDisplayStatus(status, timestamp) {
    const statusLabels = {
        'new': 'New',
        'emailed': 'Emailed',
        'replied': 'Replied',
        'call_booked': 'Call Booked',
        'purchased': 'Purchased',
        'onboarding_started': 'Chat Started',
        'onboarding_complete': 'Chat Complete',
        'joined': 'Joined (WhatsApp)'
    };

    const text = statusLabels[status] || status.replace(/_/g, ' ');
    let time = '';

    if (timestamp && status !== 'new') {
        const date = new Date(timestamp);
        time = date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
        }) + ' @ ' + date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit'
        });
    }

    return { text, time };
}

// Load notes for an application
async function loadNotes(applicationId) {
    try {
        const notes = await fetchAPI(`/notes/${applicationId}`);
        return notes;
    } catch (error) {
        console.error('Error loading notes:', error);
        return [];
    }
}

// Add a note to an application
async function addNote(applicationId, noteText) {
    try {
        const note = await fetchAPI(`/notes/${applicationId}`, {
            method: 'POST',
            body: JSON.stringify({ note_text: noteText })
        });
        showToast('Note added', 'success');
        return note;
    } catch (error) {
        showToast('Failed to add note', 'error');
        throw error;
    }
}

// Delete a note
async function deleteNote(noteId) {
    try {
        await fetchAPI(`/notes/${noteId}`, { method: 'DELETE' });
        showToast('Note deleted', 'success');
    } catch (error) {
        showToast('Failed to delete note', 'error');
        throw error;
    }
}

// Render notes section HTML
function renderNotesSection(notes, applicationId) {
    const notesList = notes.length > 0
        ? notes.map(note => `
            <div class="note-item" data-note-id="${note.id}">
                <div class="note-meta">
                    <span class="note-author">${escapeHtml(note.created_by || '')}</span>
                    <span>${formatTimeAgo(note.created_at)} ${note.slack_synced ? '<span class="slack-synced">Synced to Slack</span>' : ''}</span>
                </div>
                <div class="note-text">${escapeHtml(note.note_text)}</div>
            </div>
        `).join('')
        : '<p style="color: var(--gray-400); font-size: 0.9rem;">No notes yet</p>';

    return `
        <div class="notes-section">
            <h4>Notes</h4>
            <div class="notes-list">
                ${notesList}
            </div>
            <div class="add-note-form">
                <textarea id="new-note-text" placeholder="Add a note..."></textarea>
                <button class="btn btn-primary btn-sm" onclick="submitNote('${applicationId}')">Add Note</button>
            </div>
        </div>
    `;
}

// Submit a new note
async function submitNote(applicationId) {
    const textarea = document.getElementById('new-note-text');
    const noteText = textarea.value.trim();

    if (!noteText) {
        showToast('Please enter a note', 'error');
        return;
    }

    try {
        await addNote(applicationId, noteText);
        // Reload the application view to show the new note
        viewApplication(applicationId, { activeTab: 'notes' });
    } catch (error) {
        // Error already shown
    }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function refreshStats() {
    loadOverview();
    showToast('Dashboard refreshed', 'success');
}

// Delete member
async function deleteMember(id) {
    closeAllKebabMenus();
    if (!confirm('Are you sure you want to delete this member? This will also delete all associated team members. This action cannot be undone.')) {
        return;
    }

    try {
        await fetchAPI(`/members/${id}`, { method: 'DELETE' });
        showToast('Member deleted', 'success');
        loadMembers();
        loadOverview();
    } catch (error) {
        showToast(error.message || 'Failed to delete member', 'error');
    }
}

// Delete team member
async function deleteTeamMember(id) {
    closeAllKebabMenus();
    if (!confirm('Are you sure you want to delete this team member? This action cannot be undone.')) {
        return;
    }

    try {
        await fetchAPI(`/team-members/${id}`, { method: 'DELETE' });
        showToast('Team member deleted', 'success');
        loadTeamMembers();
        loadOverview();
    } catch (error) {
        showToast(error.message || 'Failed to delete team member', 'error');
    }
}

// Delete application
async function deleteApplication(id) {
    closeAllKebabMenus();
    if (!confirm('Are you sure you want to delete this Typeform application? This action cannot be undone.')) {
        return;
    }

    try {
        await fetchAPI(`/applications/${id}`, { method: 'DELETE' });
        showToast('Application deleted', 'success');
        loadApplications();
        loadOverview();
    } catch (error) {
        showToast(error.message || 'Failed to delete application', 'error');
    }
}

// Expose functions to global scope
window.viewApplication = viewApplication;
window.updateApplicationStatus = updateApplicationStatus;
window.updateMemberOnboardingStatus = updateMemberOnboardingStatus;
window.convertApplication = convertApplication;
window.viewMember = viewMember;
window.viewTeamMember = viewTeamMember;
window.viewSubmission = viewSubmission;
window.changePage = changePage;
window.closeModal = closeModal;
window.setActivePanelTab = setActivePanelTab;
window.refreshStats = refreshStats;
window.toggleKebabMenu = toggleKebabMenu;
window.toggleApplicationsGroup = toggleApplicationsGroup;
window.toggleMembersGroup = toggleMembersGroup;
window.toggleTeamMembersGroup = toggleTeamMembersGroup;
window.markSubmissionComplete = markSubmissionComplete;
window.deleteSubmission = deleteSubmission;
window.deleteMember = deleteMember;
window.deleteTeamMember = deleteTeamMember;
window.deleteApplication = deleteApplication;
window.submitNote = submitNote;
window.openNotesPanel = openNotesPanel;
window.submitInlineNote = submitInlineNote;

// Open notes panel inline
async function openNotesPanel(applicationId, applicantName) {
    viewApplication(applicationId, { activeTab: 'notes' });
}

// Submit note from inline panel
async function submitInlineNote(applicationId, applicantName) {
    const textarea = document.getElementById('inline-note-text') || document.getElementById('new-note-text');
    if (!textarea) {
        showToast('Note input not found', 'error');
        return;
    }
    const noteText = textarea.value.trim();

    if (!noteText) {
        showToast('Please enter a note', 'error');
        return;
    }

    try {
        await addNote(applicationId, noteText);
        // Reload the application panel (notes tab) and the applications list
        viewApplication(applicationId, { activeTab: 'notes' });
        loadApplications();
    } catch (error) {
        // Error already shown
    }
}
