# Contributing

## Commit messages

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<optional scope>): <description>

<optional body>

<optional footers>
```

- Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style`,
  `revert`.
- A breaking change adds `!` after the type or scope (`feat(auth)!: …`) and a
  `BREAKING CHANGE: <what to do>` footer.
- Lines stay under 100 characters.

[commitlint](https://commitlint.js.org) (`commitlint.config.mjs`) checks every message in the
husky `commit-msg` hook. On a pull request, the `Conventional Commits` workflow checks the title,
which becomes the commit subject of a squash merge, and the commits, which a rebase or merge
keeps. Check a message by hand with `printf '%s' 'feat: …' | pnpm exec commitlint`.

## Changelog

[`CHANGELOG.md`](CHANGELOG.md) follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
A pull request with a change visible to people who use or fork the starter adds an entry under
`## [Unreleased]`, in the matching section: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`
or `Security`.

- Write for humans: describe the effect, not the implementation, and group related changes into
  one entry.
- Start a breaking entry with `**Breaking:**` and say what to do (rename a variable, run
  `pnpm db:generate`, …).
- End the entry with the pull request link.
- Test-only changes, refactors and internal CI tweaks need no entry.

On release, the `[Unreleased]` entries move under a new `## [x.y.z] - YYYY-MM-DD` heading, and
the link references at the bottom of the file are updated: see [Releasing](#releasing).

## Releasing

A release closes a milestone whose issues are all closed.

1. Open a `docs: release vX.Y.Z` pull request that moves the `[Unreleased]` entries under
   `## [x.y.z] - YYYY-MM-DD`, leaves an empty `## [Unreleased]` above it, opens the section with
   the breaking changes to act on, and updates the link references at the bottom of the file
   (`[unreleased]` compares from the new tag, `[x.y.z]` compares the previous tag with it). Give
   every entry without one its pull request link.
2. Squash-merge it once CI is green, and check that `CHANGELOG.md` at the merge commit has nothing
   under `[Unreleased]`: another pull request may have landed first.
3. Tag that merge commit by its full SHA, not `main`:
   `git tag -a vX.Y.Z <sha> -m "vX.Y.Z — <milestone title>"`, then `git push origin vX.Y.Z`. Tag
   after the changelog cut: v0.1.0 was tagged before it, so its tree has no `[0.1.0]` section.
4. Publish the GitHub release under the milestone's title
   (`gh release create vX.Y.Z --verify-tag --title "<title>" --notes-file <file>`). The notes start
   with a "Before you upgrade" list of the breaking changes, followed by the section, with its
   relative links rewritten, since they break in a release body:

   ```bash
   sed -E 's#\]\((README\.md|docs/[A-Za-z_./-]+)#](https://github.com/juherr/nuxt-saas-starter/blob/vX.Y.Z/\1#g'
   ```

5. Close the milestone.

## Licensing

New files need licensing information: see the [License](README.md#license) section of the README.
