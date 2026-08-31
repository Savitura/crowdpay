const logger = require('../config/logger');

/**
 * Extracts owner and repo name from a GitHub URL
 * @param {string} url - e.g., https://github.com/Savitura/crowdpay
 * @returns {{ owner: string, repo: string } | null}
 */
function parseGithubUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('github.com')) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[1] };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Fetches stats for a GitHub repository
 * @param {string} repoUrl 
 * @returns {Promise<Object|null>}
 */
async function fetchGithubRepoStats(repoUrl) {
  const repoInfo = parseGithubUrl(repoUrl);
  if (!repoInfo) return null;

  const { owner, repo } = repoInfo;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'CrowdPay-Backend'
  };

  try {
    // Fetch main repo stats
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        logger.warn(`GitHub repo not found: ${owner}/${repo}`);
        return null;
      }
      throw new Error(`GitHub API error: ${repoRes.statusText}`);
    }
    const repoData = await repoRes.json();

    // Fetch top 5 contributors
    let topContributors = [];
    const contribRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=5`, { headers });
    if (contribRes.ok) {
      const contribData = await contribRes.json();
      if (Array.isArray(contribData)) {
        topContributors = contribData.map(c => ({
          login: c.login,
          avatar_url: c.avatar_url,
          html_url: c.html_url
        }));
      }
    }

    return {
      stars: repoData.stargazers_count,
      forks: repoData.forks_count,
      open_issues: repoData.open_issues_count,
      last_commit_date: repoData.pushed_at || repoData.updated_at,
      license: repoData.license ? repoData.license.spdx_id : null,
      top_contributors: topContributors
    };
  } catch (error) {
    logger.error('Failed to fetch GitHub repo stats', { repoUrl, error: error.message });
    return null;
  }
}

module.exports = {
  fetchGithubRepoStats,
  parseGithubUrl
};
