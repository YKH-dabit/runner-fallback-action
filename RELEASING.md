# Releasing

This action is consumed via `uses: YKH-dabit/runner-fallback-action@v1` (a floating major-version tag),
per GitHub Actions convention. Every release publishes an immutable `vX.Y.Z` tag, then points the
floating major-version tag at the right commit: a **patch/minor** release moves `v<major>` (e.g. `v1`)
to the new tag; a **major** release instead freezes the old floating tag where it is and creates a new
one (`v<newmajor>`), because consumers still pinned to the old line must not move underneath them. That
floating-tag step is the one most likely to be forgotten — step 4 below calls it out explicitly and is
mandatory on every release.

## Steps

1. **Open the release PR and put everything the release needs into that one commit, merged to `main`
   before you tag anything.**

   - Pick the version. Follow semver against the previous release of this action (not any inherited upstream
     version history). Update `"version"` in `package.json` (and `package-lock.json`'s matching root
     entries) to `X.Y.Z`.
   - Rebuild `dist/` if needed. `dist/` is committed and CI's `check-dist` byte-compares it against a
     fresh build. If the change since the last release touched `index.js`, `wait.js`, or any dependency,
     rebuild it here so `check-dist` stays green on the PR itself instead of surfacing a mismatch after
     merge:

     ```sh
     npm ci
     npm run prepare
     git add dist && git commit -m "build: rebuild dist/ for vX.Y.Z"
     ```

     `npm ci` already runs `prepare` as an install lifecycle hook, so the explicit `npm run prepare`
     above is belt-and-braces — it guarantees the rebuild happens even if the hook was skipped (e.g.
     `npm ci --ignore-scripts`).
   - **If this is a major-version bump**, also update `README.md`'s
     `uses: YKH-dabit/runner-fallback-action@v1` usage example to `@v<newmajor>` in this same PR. This
     has to land now: step 2 tags whichever commit this PR merges into `main`, so that commit must
     already carry the correct README line — there is no later step where fixing a stale README would
     still be possible without re-tagging.

   Merge the PR to `main`. Every step below operates on that merged commit.

2. **Tag the release commit.** Tag the `main` commit from step 1 (which already carries the version
   bump, any rebuilt `dist/`, and any major-bump README change):

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. **Publish the GitHub release.** Create a GitHub release from the `vX.Y.Z` tag (via the GitHub UI or
   `gh release create vX.Y.Z --title vX.Y.Z --notes "<summary of changes>"`).

4. **Re-point the floating major-version tag — mandatory, do not skip.** Consumers using
   `uses: YKH-dabit/runner-fallback-action@v1` only pick up the new release once this step runs;
   forgetting it silently leaves every `@v1` consumer on the old build.

   For a **patch or minor** release, move `v<major>` (e.g. `v1`) to the same commit as the new
   `vX.Y.Z` tag:

   ```sh
   git tag -f v1 vX.Y.Z
   git push origin v1 --force
   ```

   For a **major** release, do not move the old floating tag — leave it frozen on the old major line so
   consumers still pinned to it are unaffected. Instead create the new floating tag, `v<newmajor>` (e.g.
   `v2` for `2.0.0`), pointing at the same commit as `vX.Y.Z`. No `-f` / `--force` is needed here, unlike
   the patch/minor block above, because the tag is new:

   ```sh
   git tag v2 vX.Y.Z
   git push origin v2
   ```

5. **Verify.**

   - `git ls-remote --tags origin` shows `vX.Y.Z` and the floating tag you touched in step 4
     (`v<major>` for a patch/minor release, `v<newmajor>` for a major release) pointing at the same
     commit SHA.
   - The GitHub Releases page lists the new `vX.Y.Z` release.
   - For a major release, also confirm the tagged commit's `README.md` already shows the
     `@v<newmajor>` usage example (`git show vX.Y.Z:README.md | grep 'uses:'`) — this is what step 1's
     README update was for, and this check is what would have caught it being missed or misplaced.

## Notes

- The first release under this repository's own lineage is `1.0.0`, independent of any version number inherited
  from upstream history.
