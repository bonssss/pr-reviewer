// State Management
let currentTab = 'overview';
let cachedPRs = [];
let cachedRepositories = [];
let currentReviewSession = null;
let currentActivePrId = null;
let editingRepoId = null;
let currentSeverityFilter = 'ALL';

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  loadDashboardData();
  loadRepositories();
  loadPullRequests();
});

// Tab Navigation
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
  document.querySelectorAll('.tab-view').forEach((view) => view.classList.add('hidden'));

  const activeBtn = document.getElementById(`tab-btn-${tab}`);
  const activeView = document.getElementById(`view-${tab}`);

  if (activeBtn) activeBtn.classList.add('active');
  if (activeView) activeView.classList.remove('hidden');

  if (tab === 'overview') loadDashboardData();
  else if (tab === 'repositories') loadRepositories();
  else if (tab === 'pull-requests') loadPullRequests();
}

// Authentication Handling
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      if (data.user) {
        document.getElementById('btn-login').classList.add('hidden');
        const profile = document.getElementById('user-profile');
        profile.classList.remove('hidden');
        document.getElementById('user-name').textContent = data.user.username;
        if (data.user.avatarUrl) {
          document.getElementById('user-avatar').src = data.user.avatarUrl;
        }
      }
    }
  } catch (e) {
    console.debug('Unauthenticated user session');
  }
}

function loginWithGitHub() {
  window.location.href = '/api/auth/github';
}

// Data Fetching: Overview & Metrics
async function loadDashboardData() {
  try {
    const res = await fetch('/api/dashboard/stats');
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
      tbody.innerHTML = '<tr><td colspan="6" class="py-4 text-center text-gray-500">No review activity recorded yet. Open a PR to trigger analysis.</td></tr>';
      return;
    }

    tbody.innerHTML = stats.recentReviews
      .map((r) => {
        const verdictBadge = getVerdictBadge(r.recommendation, r.status);
        const riskColor = (r.riskScore || 0) >= 70 ? 'text-rose-400' : (r.riskScore || 0) >= 35 ? 'text-amber-400' : 'text-emerald-400';

        return `
          <tr class="hover:bg-dark-700/50 transition">
            <td class="py-3 px-3 font-medium text-white">#${r.prNumber} ${escapeHtml(r.prTitle)}</td>
            <td class="py-3 px-3 font-mono text-gray-400">${escapeHtml(r.repoFullName)}</td>
            <td class="py-3 px-3">${verdictBadge}</td>
            <td class="py-3 px-3 font-bold ${riskColor}">${r.riskScore !== null ? `${r.riskScore}/100` : '--'}</td>
            <td class="py-3 px-3">${r.totalIssues} ${r.criticalIssues > 0 ? `<span class="text-rose-400 font-bold">(${r.criticalIssues} 🚨)</span>` : ''}</td>
            <td class="py-3 px-3 text-right">
              <button onclick="openReviewModal('${r.id}')" class="px-2.5 py-1 rounded bg-dark-700 hover:bg-dark-600 text-gray-200 border border-dark-600 transition">
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

// Data Fetching: Repositories
async function loadRepositories() {
  try {
    const res = await fetch('/api/repositories');
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
                  <input type="checkbox" ${repo.autoReviewEnabled ? 'checked' : ''} onchange="toggleAutoReview('${repo.id}', this.checked)" class="rounded bg-dark-900 border-dark-600 text-emerald-500 focus:ring-0">
                  <span class="ml-1.5 text-[11px] text-gray-400">Auto-Review</span>
                </label>
              </div>
              <h3 class="text-base font-bold text-white mt-1 tracking-tight">${escapeHtml(repo.fullName)}</h3>
              <p class="text-xs text-gray-400 mt-0.5">Default branch: <span class="font-mono text-gray-300">${escapeHtml(repo.defaultBranch)}</span></p>
            </div>

            <div class="pt-3 border-t border-dark-700 flex items-center justify-between">
              <span class="text-xs text-gray-400">${prCount} Pull Requests</span>
              <button onclick="openRepoModal('${repo.id}')" class="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-white text-xs font-medium border border-dark-600 transition">
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

// Data Fetching: Pull Requests
async function loadPullRequests() {
  try {
    const res = await fetch('/api/dashboard/prs');
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
    tbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-gray-500">No pull requests found.</td></tr>';
    return;
  }

  tbody.innerHTML = prs
    .map((pr) => {
      const latestReview = pr.reviewSessions?.[0];
      const verdict = latestReview ? getVerdictBadge(latestReview.recommendation, latestReview.status) : '<span class="text-gray-500">No review</span>';
      const riskColor = (latestReview?.riskScore || 0) >= 70 ? 'text-rose-400' : (latestReview?.riskScore || 0) >= 35 ? 'text-amber-400' : 'text-emerald-400';

      return `
        <tr class="hover:bg-dark-700/50 transition">
          <td class="py-3 px-4 font-semibold text-white">
            <a href="${pr.htmlUrl}" target="_blank" class="hover:underline flex items-center space-x-1.5">
              <span>#${pr.number} ${escapeHtml(pr.title)}</span>
              <span class="text-gray-500 text-[10px]">↗</span>
            </a>
            <div class="text-[11px] text-gray-400 font-normal">by ${escapeHtml(pr.author)}</div>
          </td>
          <td class="py-3 px-4 font-mono text-gray-400">${escapeHtml(pr.repository?.fullName || '')}</td>
          <td class="py-3 px-4 font-mono text-[11px] text-gray-400">${escapeHtml(pr.baseBranch)} &larr; ${escapeHtml(pr.headBranch)}</td>
          <td class="py-3 px-4">
            <span class="px-2 py-0.5 rounded text-[11px] font-mono ${latestReview?.status === 'COMPLETED' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-dark-600 text-gray-300'}">
              ${latestReview?.status || 'PENDING'}
            </span>
          </td>
          <td class="py-3 px-4">${verdict}</td>
          <td class="py-3 px-4 font-bold ${riskColor}">
            ${latestReview?.riskScore !== null && latestReview?.riskScore !== undefined ? `${latestReview.riskScore}/100` : '--'}
          </td>
          <td class="py-3 px-4 text-right">
            ${
              latestReview
                ? `<button onclick="openReviewModal('${latestReview.id}')" class="px-2.5 py-1 rounded bg-dark-700 hover:bg-dark-600 text-gray-200 border border-dark-600 transition">Inspect &rarr;</button>`
                : `<button onclick="triggerReReviewFromPrId('${pr.id}')" class="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white transition">Review</button>`
            }
          </td>
        </tr>
      `;
    })
    .join('');
}

function filterPullRequests() {
  const query = document.getElementById('pr-search-input').value.toLowerCase();
  const filtered = cachedPRs.filter(
    (pr) =>
      pr.title.toLowerCase().includes(query) ||
      pr.author.toLowerCase().includes(query) ||
      pr.repository?.fullName.toLowerCase().includes(query)
  );
  renderPullRequests(filtered);
}

// Modal: AI Review Report Details
async function openReviewModal(sessionId) {
  try {
    const res = await fetch(`/api/reviews/session/${sessionId}`);
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
      banner.className = 'p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 flex items-center justify-between';
      recText.textContent = '🟢 RECOMMENDED: APPROVE';
    } else if (session.recommendation === 'REQUEST_CHANGES') {
      banner.className = 'p-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 flex items-center justify-between';
      recText.textContent = '🔴 RECOMMENDED: REQUEST CHANGES';
    } else {
      banner.className = 'p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 flex items-center justify-between';
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
  const filtered = severity === 'ALL' ? allComments : allComments.filter((c) => c.severity === severity);
  renderModalIssues(filtered);
}

function renderModalIssues(issues) {
  const container = document.getElementById('modal-issues-container');
  document.getElementById('modal-issues-count').textContent = issues.length;

  if (issues.length === 0) {
    container.innerHTML = '<div class="p-6 text-center text-gray-500 bg-dark-900/50 rounded-xl">No issues found matching the selected filter.</div>';
    return;
  }

  container.innerHTML = issues
    .map((issue) => {
      const severityBadge = getSeverityBadge(issue.severity);
      return `
        <div class="p-4 rounded-xl bg-dark-900 border border-dark-600 space-y-2.5">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-2">
              ${severityBadge}
              <span class="font-bold text-white text-xs">${escapeHtml(issue.title)}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-dark-700 text-gray-400 font-mono">${issue.category}</span>
            </div>
            <span class="text-[11px] font-mono text-gray-400">${escapeHtml(issue.filePath)}:L${issue.lineNumber}</span>
          </div>

          <p class="text-xs text-gray-300 leading-relaxed">${escapeHtml(issue.message)}</p>

          ${
            issue.suggestion
              ? `
            <div class="mt-2 space-y-1">
              <div class="flex items-center justify-between text-[11px] text-gray-400 font-semibold">
                <span>Suggested Solution:</span>
                <button onclick="copySnippet(this, \`${escapeJs(issue.suggestion)}\`)" class="text-emerald-400 hover:text-emerald-300 text-[10px]">
                  📋 Copy Fix
                </button>
              </div>
              <pre class="text-[11px] text-emerald-300 border border-dark-700"><code>${escapeHtml(issue.suggestion)}</code></pre>
            </div>
          `
              : ''
          }
        </div>
      `;
    })
    .join('');
}

// Actions: Trigger Re-Review
async function triggerReReview() {
  if (!currentActivePrId) return;
  await triggerReReviewFromPrId(currentActivePrId);
  closeReviewModal();
}

async function triggerReReviewFromPrId(prId) {
  try {
    const btn = document.getElementById('modal-btn-rerun');
    if (btn) btn.disabled = true;

    const res = await fetch(`/api/reviews/pr/${prId}/rerun`, { method: 'POST' });
    if (res.ok) {
      alert('⚡ Re-review requested successfully! Analysis is running in background.');
      loadDashboardData();
      loadPullRequests();
    } else {
      alert('Please connect your GitHub account to trigger re-reviews.');
    }
  } catch (error) {
    console.error('Failed to trigger re-review:', error);
  }
}

// Modal: Repository Guidelines Editor
function openRepoModal(repoId) {
  editingRepoId = repoId;
  const repo = cachedRepositories.find((r) => r.id === repoId);
  if (!repo) return;

  document.getElementById('modal-repo-prompt').value = repo.customPrompt || '';
  document.getElementById('modal-repo-auto-review').checked = repo.autoReviewEnabled;
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
    const res = await fetch(`/api/repositories/${editingRepoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customPrompt: prompt, autoReviewEnabled: autoReview }),
    });

    if (res.ok) {
      closeRepoModal();
      loadRepositories();
    } else {
      alert('Could not update repository settings. Please sign in.');
    }
  } catch (error) {
    console.error('Failed to save repo settings:', error);
  }
}

async function toggleAutoReview(repoId, enabled) {
  try {
    await fetch(`/api/repositories/${repoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoReviewEnabled: enabled }),
    });
    loadRepositories();
  } catch (error) {
    console.error('Failed to toggle auto-review:', error);
  }
}

// Helpers
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
  if (severity === 'CRITICAL') return '<span class="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 font-bold text-[10px]">CRITICAL</span>';
  if (severity === 'HIGH') return '<span class="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 font-bold text-[10px]">HIGH</span>';
  if (severity === 'MEDIUM') return '<span class="px-1.5 py-0.5 rounded bg-yellow-400/10 text-yellow-300 font-medium text-[10px]">MEDIUM</span>';
  return '<span class="px-1.5 py-0.5 rounded bg-blue-400/10 text-blue-300 font-medium text-[10px]">LOW</span>';
}

function copySnippet(btn, text) {
  navigator.clipboard.writeText(text);
  const oldText = btn.innerHTML;
  btn.innerHTML = '✓ Copied!';
  setTimeout(() => (btn.innerHTML = oldText), 1500);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeJs(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}
