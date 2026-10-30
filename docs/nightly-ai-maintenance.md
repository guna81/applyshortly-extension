# Nightly Copilot review / issue fixing (owner-approval required)

## Current status
These files **define agents and setup instructions**, but do not install GitHub Copilot cloud automations. Automations are configured separately in GitHub's Agents interface and are not versioned as repository files. As of October 2026 Copilot cloud automations require an eligible Copilot plan and a **private or internal repository**; this repository is public. Leave it public unless the owner explicitly decides otherwise.

## Proposed cloud automations (after eligibility is resolved)
**Automation A — Nightly reviewer**
- Repository: `guna81/applyshortly-extension`
- Trigger: Daily, **00:00 Asia/Kolkata** (18:30 UTC of previous calendar date). Confirm scheduling timezone in GitHub UI.
- Prompt: "Act as the repository custom agent nightly-reviewer; follow .github/agents/nightly-reviewer.agent.md. Review the repo for verified P0/P1 bugs, create up to five deduplicated issues and report findings. Never change code."
- Grant repository read, issue read/create/label; do **not** grant code-write or merge rights when tool selection allows.

**Automation B — Issue fixer**
- Trigger: Issue created; use GitHub issue search filter such as `is:issue is:open label:ai-fix-ready` if supported. Confirm filtering also recognizes `priority:p0` and `priority:p1`, or check them in prompt.
- Prompt: "Act as repository custom agent issue-fixer; follow .github/agents/issue-fixer.agent.md. Only fix confirmed high-priority ai-fix-ready issues. Open a separate DRAFT PR. NEVER merge, publish or deploy. Report back in the issue."
- Grant issue read/comment, branch/code write, PR create; disable PR merge and deployment if configurable.
- Avoid recursive automation triggering and ensure only one fix is in progress per issue. An issue that gains a label *after* creation may not trigger an issue-created automation: label it at creation or set up a separate supported handoff.

## Owner's required approval configuration
In GitHub repository **Settings → Rules → Rulesets** (or **Settings → Branches → Branch protection**), protect `main`:
1. Require pull requests before merging and **at least 1 required approval**.
2. Require review from code owners where supported. Configure a `CODEOWNERS` entry such as `* @guna81` if appropriate.
3. Dismiss stale approvals after pushes; require passing `npm run check` CI and no unresolved review threads when available.
4. Block force pushes, deletion and bypass for agents. Do not allow auto-merge or direct bot push to `main`.
5. Approval cannot reliably be from the PR's own author. On a personal repository, review the exact GitHub plan, repo visibility and contributor model to verify the chosen branch protection rules actually enforce the desired owner-only gate.

**Approval policy:** All agent fixes remain draft PRs. The owner must manually inspect, approve and merge each change; no production deploy or Chrome Web Store publication is permitted automatically.

## Verification checklist
- [ ] Merge this setup draft PR after inspecting it.
- [ ] Decide whether to use a private repo or an alternative publicly supported automation method; do not change visibility without approval.
- [ ] Verify Copilot plan/agent enablement and create both automations in the GitHub Agents UI.
- [ ] Enable and test main branch ruleset / required reviews.
- [ ] Add a trusted CI status check on PRs using existing `npm run check` if one is not present.
- [ ] Test issue → draft PR handoff with a disposable issue; verify nothing merges on its own.
- [ ] Configure GitHub notifications to receive issue/PR reports.

Note: GitHub Actions cron uses UTC unless a workflow supports an explicit timezone; `30 18 * * *` corresponds to 00:00 IST the following day. Scheduled GitHub Actions jobs can start late.
