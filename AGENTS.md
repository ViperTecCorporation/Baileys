# AGENTS.md

## addbuttonsupport upstream sync

- When bringing new `origin/master` changes into `addbuttonsupport`, prefer cherry-picking the upstream commits in order with `git cherry-pick --no-commit <hash>`.
- Commit the resulting patches with `Author` and `Committer` set to `caitano28 <caitano28@gmail.com>`.
- Keep the original upstream commit hash in the commit body as `(cherry picked from commit <hash>)`.
- Before applying an upstream commit, check whether the same behavior was already ported locally under a different hash; skip already-ported commits instead of duplicating them.
- Preserve local `addbuttonsupport` behavior when resolving conflicts, especially interactive/list-message support, tctoken customizations, and raw message debug logging.

## 2026-04-25 sync notes

- Applied the new commits from `origin/master` after `8e5093c` onto `addbuttonsupport`.
- Skipped `ac90a2d` because it was already ported as `f50feea`.
- Skipped `402f479` because the tctoken lifecycle work was already ported through the local tctoken commits.
