import { escapeHtml, sanitizeUrl } from './sanitize.js';

// State Management
let currentTab = 'overview';
let cachedPRs = [];
let cachedRepositories = [];
let currentReviewSession = null;
let currentActivePrId = null;
let editingRepoId = null;
let currentSeverityFilter = 'ALL';
let isAuthenticated = false;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function init() {
  document.addEventListener('click', onDelegatedClick);
  document.addEventListener('change', onDelegatedChange);

  const searchInput = document.getElementById('pr-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', filterPullRequests);
  }

  void start();
}

async function start() {
  const authError = consumeAuthError();
  const authenticated = await checkAuth();
  if (!authenticated) {
    showAuthGate(authError);
    return;
  }

  await Promise.all([loadDashboardData(), loadRepositories(), loadPullRequests()]);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

// ---------------------------------------------------------------------------
// Delegated event handling (no inline handlers, CSP friendly)
// ---------------------------------------------------------------------------

function onDelegatedClick(event) {
  const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (!target) return;

  const action = target.dataset.action;
  if (action === 'login') {
    loginWithGitHub();
    return;
  }

  if (!isAuthenticated) {
    showAuthGate();
    return;
  }

  switch (action) {
    case 'switch-tab':
      switchTab(target.dataset.tab);
      break;
    case 'refresh-dashboard':
      void loadDashboardData();
      break;
    case 'open-review':
      void openReviewModal(target.dataset.sessionId);
      break;
    case 'open-repo':
      openRepoModal(target.dataset.repoId);
      break;
    case 'rerun-pr':
      void triggerReReviewFromPrId(target.dataset.prId);
      break;
    case 'rerun-review':
      void triggerReReview();
      break;
    case 'close-review':
      closeReviewModal();
      break;
    case 'close-repo':
      closeRepoModal();
      break;
    case 'filter-issues':
      filterIssues(target.dataset.severity);
      break;
    case 'copy-suggestion':
      copySnippet(target, target.dataset.suggestion || '');
      break;
    case 'save-repo':
      void saveRepoSettings();
      break;
    default:
      break;
  }
}

function onDelegatedChange(event) {
  const target =
    event.target instanceof Element ? event.target.closest('[data-action="toggle-auto-review"]') : null;
  if (!target) return;

  if (!isAuthenticated) {
    showAuthGate();
    return;
  }

  void toggleAutoReview(target.dataset.repoId, target.checked);
}

// ---------------------------------------------------------------------------
// Tab Navigation
// ---------------------------------------------------------------------------

function switchTab(tab) {
  if (!isAuthenticated) {
    showAuthGate();
    return;
  }

  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
  document.querySelectorAll('.tab-view').forEach((view) => view.classList.add('hidden'));

  const activeBtn = document.getElementById(`tab-btn-${tab}`);
  const activeView = document.getElementById(`view-${tab}`);

  if (activeBtn) activeBtn.classList.add('active');
  if (activeView) activeView.classList.remove('hidden');

  if (tab === 'overview') void loadDashboardData();
  else if (tab === 'repositories') void loadRepositories();
  else if (tab === 'pull-requests') void loadPullRequests();
}

// ---------------------------------------------------------------------------
// Authentication Handling
// ---------------------------------------------------------------------------

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return false;

    const data = await res.json();
    if (!data.user) return false;

    isAuthenticated = true;

    document.getElementById('btn-login')?.classList.add('hidden');
    const profile = document.getElementById('user-profile');
    profile?.classList.remove('hidden');
    profile?.classList.add('flex');

    document.getElementById('user-name').textContent = data.user.username || '';

    const avatarUrl = sanitizeUrl(data.user.avatarUrl);
    const avatar = document.getElementById('user-avatar');
    if (avatar && avatarUrl) avatar.src = avatarUrl;

    document.getElementById('auth-gate')?.classList.add('hidden');

    return true;
  } catch (error) {
    console.debug('Unauthenticated user session', error);
    return false;
  }
}

function showAuthGate(reason) {
  isAuthenticated = false;

  document.getElementById('auth-gate')?.classList.remove('hidden');
  document.querySelectorAll('.tab-view').forEach((view) => view.classList.add('hidden'));
  document.getElementById('nav-tabs')?.classList.add('hidden');
  document.getElementById('user-profile')?.classList.add('hidden');
  document.getElementById('btn-login')?.classList.remove('hidden');

  const errorEl = document.getElementById('auth-error');
  if (errorEl) {
    const message = reason ? AUTH_ERROR_MESSAGES[reason] || AUTH_ERROR_MESSAGES.auth_failed : '';
    errorEl.textContent = message;
    errorEl.classList.toggle('hidden', !message);
  }
}

const AUTH_ERROR_MESSAGES = {
  state: 'Your sign-in link expired or was already used. Please connect GitHub again.',
  missing_code: 'GitHub did not return an authorization code. Please try again.',
  auth_failed: 'GitHub sign-in failed. Check the server logs and try again.',
};

/**
 * Reads `?auth_error=...` set by the OAuth callback, then removes it from the
 * address bar so a refresh does not replay a stale message.
 */
function consumeAuthError() {
  const params = new URLSearchParams(window.location.search);
  const reason = params.get('auth_error');
  if (!reason) return null;

  params.delete('auth_error');
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}`
  );

  return reason;
}

function loginWithGitHub() {
  window.location.href = '/api/auth/github';
}

/** Returns true when the response was a 401 and the auth gate was shown. */
function handleUnauthorized(res) {
  if (res.status === 401) {
    showAuthGate();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Data Fetching: Overview & Metrics
// ---------------------------------------------------------------------------

async function loadDashboardData() {
  try {
    const res = await fetch('/api/dashboard/stats', { credentials: 'same-origin' });
    if (handleUnauthorized(res)) return;
    if (!res.ok) return;

    const { stats } = await res.json();

    document.getElementById('stat-total-prs').textContent = stats.totalPullRequests;
    document.getElementById('stat-avg-risk').textContent = `${stats.averageRiskScore}%`;
    document.getElementById('stat-critical-issues').textContent = stats.criticalIssues;
    document.getElementById('stat-total-repos').textContent = stats.totalRepositories;
    document.getElementById('stat-total-issues').textContent = `${stats.totalIssues} Total Issues`;

    // Severity Counts & Bars
    document.getElementById('stat-count-critical').textContent = stats.criticalIssues;
    document.getElementById('stat-count-high').textContent = stats.highIssues;
    document.getElementById('stat-count-medium').textContent = stats.mediumIssues;
    document.getElementById('stat-count-low').textContent = stats.lowIssues;

    const total = Math.max(stats.totalIssues, 1);
    document.getElementById('bar-critical').style.width = `${(stats.criticalIssues / total) * 100}%`;
    document.getElementById('bar-high').style.width = `${(stats.highIssues / total) * 100}%`;
    document.getElementById('bar-medium').style.width = `${(stats.mediumIssues / total) * 100}%`;
    document.getElementById('bar-low').style.width = `${(stats.lowIssues / total) * 100}%`;

    // Risk Badge
    const riskBadge = document.getElementById('stat-risk-badge');
    if (stats.averageRiskScore >= 70) {
      riskBadge.textContent = 'High';
      riskBadge.className = 'text-xs font-medium px-2 py-0.5 rounded bg-rose-500/10 text-rose-400';
    } else if (stats.averageRiskScore >= 35) {
      riskBadge.textContent = 'Medium';
      riskBadge.className = 'text-xs font-medium px-2 py-0.5 rounded bg-amber-500/10 text-amber-400';
    } else {
      riskBadge.textContent = 'Low';
      riskBadge.className = 'text-xs font-medium px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400';
    }

    // Render Recent Reviews Table
    const tbody = document.getElementById('recent-reviews-table');
    if (!stats.recentReviews || stats.recentReviews.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="py-4 text-center text-gray-500">No review activity recorded yet. Open a PR to trigger analysis.</td></tr>';
      return;
    }

    tbody.innerHTML = stats.recentReviews
      .map((review) => {
        const verdictBadge = getVerdictBadge(review.recommendation, review.status);
        const score = review.riskScore || 0;
        const riskColor =
          score >= 70 ? 'text-rose-400' : score >= 35 ? 'text-amber-400' : 'text-emerald-400';

        return `
          <tr class="hover:bg-dark-700/50 transition">
            <td class="py-3 px-3 font-medium text-white">#${escapeHtml(review.prNumber)} ${escapeHtml(review.prTitle)}</td>
            <td class="py-3 px-3 font-mono text-gray-400">${escapeHtml(review.repoFullName)}</td>
            <td class="py-3 px-3">${verdictBadge}</td>
            <td class="py-3 px-3 font-bold ${riskColor}">${review.riskScore !== null ? `${escapeHtml(review.riskScore)}/100` : '--'}</td>
            <td class="py-3 px-3">${escapeHtml(review.totalIssues)} ${review.criticalIssues > 0 ? `<span class="text-rose-400 font-bold">(${escapeHtml(review.criticalIssues)} 🚨)</span>` : ''}</td>
            <td class="py-3 px-3 text-right">
              <button data-action="open-review" data-session-id="${escapeHtml(review.id)}" class="px-2.5 py-1 rounded bg-dark-700 hover:bg-dark-600 text-gray-200 border border-dark-600 transition">
                View Report &rarr;
              </button>
            </td>
          </tr>
        `;
      })
      .join('');
  } catch (error) {
    console.error('Failed to load overview data:', error);
  }
}

// ---------------------------------------------------------------------------
// Data Fetching: Repositories
// ---------------------------------------------------------------------------

async function loadRepositories() {
  try {
    const res = await fetch('/api/repositories', { credentials: 'same-origin' });
    if (handleUnauthorized(res)) return;
    if (!res.ok) return;

    const { repositories } = await res.json();
    cachedRepositories = repositories;

    const grid = document.getElementById('repositories-grid');
    if (!repositories || repositories.length === 0) {
      grid.innerHTML = `
        <div class="col-span-full p-8 text-center bg-dark-800 border border-dark-600 rounded-xl text-gray-400">
          <p class="text-sm font-medium">No repositories connected yet.</p>
          <p class="text-xs mt-1 text-gray-500">Install the GitHub App on your organization or personal account to start automatic PR reviews.</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = repositories
      .map((repo) => {
        const prCount = repo._count?.pullRequests || 0;
        return `
          <div class="p-5 rounded-xl bg-dark-800 border border-dark-600 flex flex-col justify-between space-y-4 hover:border-dark-500 transition">
            <div>
              <div class="flex items-center justify-between">
                <span class="text-xs font-mono font-medium text-emerald-400">${repo.isPrivate ? '🔒 Private' : '🌐 Public'}</span>
                <label class="flex items-center cursor-pointer">
                  <input type="checkbox" data-action="toggle-auto-review" data-repo-id="${escapeHtml(repo.id)}" ${repo.autoReviewEnabled ? 'checked' : ''} class="rounded bg-dark-900 border-dark-600 text-emerald-500 focus:ring-0">
                  <span class="ml-1.5 text-[11px] text-gray-400">Auto-Review</span>
                </label>
              </div>
              <h3 class="text-base font-bold text-white mt-1 tracking-tight">${escapeHtml(repo.fullName)}</h3>
              <p class="text-xs text-gray-400 mt-0.5">Default branch: <span class="font-mono text-gray-300">${escapeHtml(repo.defaultBranch)}</span></p>
            </div>

            <div class="pt-3 border-t border-dark-700 flex items-center justify-between">
              <span class="text-xs text-gray-400">${escapeHtml(prCount)} Pull Requests</span>
              <button data-action="open-repo" data-repo-id="${escapeHtml(repo.id)}" class="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-white text-xs font-medium border border-dark-600 transition">
                ⚙️ Custom Rules
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  } catch (error) {
    console.error('Failed to load repositories:', error);
  }
}

// ---------------------------------------------------------------------------
// Data Fetching: Pull Requests
// ---------------------------------------------------------------------------

async function loadPullRequests() {
  try {
    const res = await fetch('/api/dashboard/prs', { credentials: 'same-origin' });
    if (handleUnauthorized(res)) return;
    if (!res.ok) return;

    const { pullRequests } = await res.json();
    cachedPRs = pullRequests;
    renderPullRequests(cachedPRs);
  } catch (error) {
    console.error('Failed to load pull requests:', error);
  }
}

function renderPullRequests(prs) {
  const tbody = document.getElementById('pull-requests-table');
  if (!prs || prs.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="py-6 text-center text-gray-500">No pull requests found.</td></tr>';
    return;
  }

  tbody.innerHTML = prs
    .map((pr) => {
      const latestReview = pr.reviewSessions?.[0];
      const verdict = latestReview
        ? getVerdictBadge(latestReview.recommendation, latestReview.status)
        : '<span class="text-gray-500">No review</span>';
      const score = latestReview?.riskScore || 0;
      const riskColor =
        score >= 70 ? 'text-rose-400' : score >= 35 ? 'text-amber-400' : 'text-emerald-400';
      const htmlUrl = sanitizeUrl(pr.htmlUrl);

      const titleInner = `<span>#${escapeHtml(pr.number)} ${escapeHtml(pr.title)}</span>`;
      const title = htmlUrl
        ? `<a href="${escapeHtml(htmlUrl)}" target="_blank" rel="noopener noreferrer" class="hover:underline flex items-center space-x-1.5">
             ${titleInner}
             <span class="text-gray-500 text-[10px]">↗</span>
           </a>`
        : `<span class="flex items-center space-x-1.5">${titleInner}</span>`;

      const action = latestReview
        ? `<button data-action="open-review" data-session-id="${escapeHtml(latestReview.id)}" class="px-2.5 py-1 rounded bg-dark-700 hover:bg-dark-600 text-gray-200 border border-dark-600 transition">Inspect &rarr;</button>`
        : `<button data-action="rerun-pr" data-pr-id="${escapeHtml(pr.id)}" class="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white transition">Review</button>`;

      return `
        <tr class="hover:bg-dark-700/50 transition">
          <td class="py-3 px-4 font-semibold text-white">
            ${title}
            <div class="text-[11px] text-gray-400 font-normal">by ${escapeHtml(pr.author)}</div>
          </td>
          <td class="py-3 px-4 font-mono text-gray-400">${escapeHtml(pr.repository?.fullName || '')}</td>
          <td class="py-3 px-4 font-mono text-[11px] text-gray-400">${escapeHtml(pr.baseBranch)} &larr; ${escapeHtml(pr.headBranch)}</td>
          <td class="py-3 px-4">
            <span class="px-2 py-0.5 rounded text-[11px] font-mono ${latestReview?.status === 'COMPLETED' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-dark-600 text-gray-300'}">
              ${escapeHtml(latestReview?.status || 'PENDING')}
            </span>
          </td>
          <td class="py-3 px-4">${verdict}</td>
          <td class="py-3 px-4 font-bold ${riskColor}">
            ${latestReview?.riskScore !== null && latestReview?.riskScore !== undefined ? `${escapeHtml(latestReview.riskScore)}/100` : '--'}
          </td>
          <td class="py-3 px-4 text-right">${action}</td>
        </tr>
      `;
    })
    .join('');
}

function filterPullRequests() {
  const input = document.getElementById('pr-search-input');
  const query = (input?.value || '').toLowerCase();

  const filtered = cachedPRs.filter((pr) => {
    const title = (pr.title || '').toLowerCase();
    const author = (pr.author || '').toLowerCase();
    const repo = (pr.repository?.fullName || '').toLowerCase();
    return title.includes(query) || author.includes(query) || repo.includes(query);
  });

  renderPullRequests(filtered);
}

// ---------------------------------------------------------------------------
// Modal: AI Review Report Details
// ---------------------------------------------------------------------------

async function openReviewModal(sessionId) {
  try {
    const res = await fetch(`/api/reviews/session/${encodeURIComponent(sessionId)}`, {
      credentials: 'same-origin',
    });
    if (handleUnauthorized(res)) return;
    if (!res.ok) return;

    const { session } = await res.json();
    currentReviewSession = session;
    currentActivePrId = session.prId;

    document.getElementById('modal-pr-number').textContent = `#${session.pullRequest.number}`;
    document.getElementById('modal-pr-title').textContent = session.pullRequest.title;
    document.getElementById('modal-repo-name').textContent = session.pullRequest.repository.fullName;
    document.getElementById('modal-summary').textContent = session.summary || 'No summary generated.';
    document.getElementById('modal-risk-score').textContent = `${session.riskScore ?? 0}/100`;

    // Verdict Banner Styling
    const banner = document.getElementById('modal-verdict-banner');
    const recText = document.getElementById('modal-recommendation');
    if (session.recommendation === 'APPROVE') {
      banner.className =
        'p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 flex items-center justify-between';
      recText.textContent = '🟢 RECOMMENDED: APPROVE';
    } else if (session.recommendation === 'REQUEST_CHANGES') {
      banner.className =
        'p-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 flex items-center justify-between';
      recText.textContent = '🔴 RECOMMENDED: REQUEST CHANGES';
    } else {
      banner.className =
        'p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 flex items-center justify-between';
      recText.textContent = '🟡 RECOMMENDED: COMMENT & IMPROVE';
    }

    renderModalIssues(session.comments || []);
    document.getElementById('review-modal').classList.remove('hidden');
  } catch (error) {
    console.error('Failed to open review modal:', error);
  }
}

function closeReviewModal() {
  document.getElementById('review-modal').classList.add('hidden');
}

function filterIssues(severity) {
  currentSeverityFilter = severity;
  if (!currentReviewSession) return;

  const allComments = currentReviewSession.comments || [];
  const filtered =
    severity === 'ALL' ? allComments : allComments.filter((comment) => comment.severity === severity);
  renderModalIssues(filtered);
}

function renderModalIssues(issues) {
  const container = document.getElementById('modal-issues-container');
  document.getElementById('modal-issues-count').textContent = issues.length;

  if (issues.length === 0) {
    container.innerHTML =
      '<div class="p-6 text-center text-gray-500 bg-dark-900/50 rounded-xl">No issues found matching the selected filter.</div>';
    return;
  }

  container.innerHTML = issues
    .map((issue) => {
      const severityBadge = getSeverityBadge(issue.severity);
      const suggestion = issue.suggestion
        ? `
            <div class="mt-2 space-y-1">
              <div class="flex items-center justify-between text-[11px] text-gray-400 font-semibold">
                <span>Suggested Solution:</span>
                <button data-action="copy-suggestion" data-suggestion="${escapeHtml(issue.suggestion)}" class="text-emerald-400 hover:text-emerald-300 text-[10px]">
                  📋 Copy Fix
                </button>
              </div>
              <pre class="text-[11px] text-emerald-300 border border-dark-700"><code>${escapeHtml(issue.suggestion)}</code></pre>
            </div>
          `
        : '';

      return `
        <div class="p-4 rounded-xl bg-dark-900 border border-dark-600 space-y-2.5">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-2">
              ${severityBadge}
              <span class="font-bold text-white text-xs">${escapeHtml(issue.title)}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-dark-700 text-gray-400 font-mono">${escapeHtml(issue.category)}</span>
            </div>
            <span class="text-[11px] font-mono text-gray-400">${escapeHtml(issue.filePath)}:L${escapeHtml(issue.lineNumber)}</span>
          </div>

          <p class="text-xs text-gray-300 leading-relaxed">${escapeHtml(issue.message)}</p>
          ${suggestion}
        </div>
      `;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Actions: Trigger Re-Review
// ---------------------------------------------------------------------------

async function triggerReReview() {
  if (!currentActivePrId) return;
  await triggerReReviewFromPrId(currentActivePrId);
  closeReviewModal();
}

async function triggerReReviewFromPrId(prId) {
  try {
    const btn = document.getElementById('modal-btn-rerun');
    if (btn) btn.disabled = true;

    const res = await fetch(`/api/reviews/pr/${encodeURIComponent(prId)}/rerun`, {
      method: 'POST',
      credentials: 'same-origin',
    });

    if (handleUnauthorized(res)) return;

    if (res.ok) {
      alert('⚡ Re-review requested successfully! Analysis is running in background.');
      void loadDashboardData();
      void loadPullRequests();
    } else {
      let message = 'Could not request a re-review.';
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {
        // Ignore non-JSON error bodies.
      }
      alert(message);
    }
  } catch (error) {
    console.error('Failed to trigger re-review:', error);
  } finally {
    const btn = document.getElementById('modal-btn-rerun');
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Modal: Repository Guidelines Editor
// ---------------------------------------------------------------------------

function openRepoModal(repoId) {
  editingRepoId = repoId;
  const repo = cachedRepositories.find((candidate) => candidate.id === repoId);
  if (!repo) return;

  document.getElementById('modal-repo-prompt').value = repo.customPrompt || '';
  document.getElementById('modal-repo-auto-review').checked = Boolean(repo.autoReviewEnabled);
  document.getElementById('repo-settings-modal').classList.remove('hidden');
}

function closeRepoModal() {
  document.getElementById('repo-settings-modal').classList.add('hidden');
  editingRepoId = null;
}

async function saveRepoSettings() {
  if (!editingRepoId) return;

  const prompt = document.getElementById('modal-repo-prompt').value;
  const autoReview = document.getElementById('modal-repo-auto-review').checked;

  try {
    const res = await fetch(`/api/repositories/${encodeURIComponent(editingRepoId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ customPrompt: prompt, autoReviewEnabled: autoReview }),
    });

    if (handleUnauthorized(res)) return;

    if (res.ok) {
      closeRepoModal();
      void loadRepositories();
    } else {
      alert('Could not update repository settings.');
    }
  } catch (error) {
    console.error('Failed to save repo settings:', error);
  }
}

async function toggleAutoReview(repoId, enabled) {
  try {
    const res = await fetch(`/api/repositories/${encodeURIComponent(repoId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ autoReviewEnabled: enabled }),
    });

    if (handleUnauthorized(res)) return;
    void loadRepositories();
  } catch (error) {
    console.error('Failed to toggle auto-review:', error);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getVerdictBadge(recommendation, status) {
  if (status === 'IN_PROGRESS' || status === 'PENDING') {
    return '<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-500/10 text-blue-400">ANALYZING</span>';
  }
  if (recommendation === 'APPROVE') {
    return '<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 font-bold">APPROVED</span>';
  }
  if (recommendation === 'REQUEST_CHANGES') {
    return '<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 font-bold">CHANGES REQ</span>';
  }
  return '<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/10 text-amber-400 font-bold">COMMENT</span>';
}

function getSeverityBadge(severity) {
  if (severity === 'CRITICAL')
    return '<span class="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 font-bold text-[10px]">CRITICAL</span>';
  if (severity === 'HIGH')
    return '<span class="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 font-bold text-[10px]">HIGH</span>';
  if (severity === 'MEDIUM')
    return '<span class="px-1.5 py-0.5 rounded bg-yellow-400/10 text-yellow-300 font-medium text-[10px]">MEDIUM</span>';
  return '<span class="px-1.5 py-0.5 rounded bg-blue-400/10 text-blue-300 font-medium text-[10px]">LOW</span>';
}

function copySnippet(btn, text) {
  if (!navigator.clipboard?.writeText) return;

  void navigator.clipboard.writeText(text).catch(() => undefined);
  const oldText = btn.textContent;
  btn.textContent = '✓ Copied!';
  setTimeout(() => {
    btn.textContent = oldText;
  }, 1500);
}
