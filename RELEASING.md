# Releasing @nearpays/partner

Releases publish from GitHub Actions (`.github/workflows/ci.yml`) when a
`vX.Y.Z` tag is pushed. No npm token is stored anywhere:
npm trusts this repository's workflow directly (trusted publishing), and each
version carries provenance linking it to the commit it was built from.

## Once: set up npm

1. Create a Nearpays npm account (a company email, with 2FA on) and the
   `nearpays` organisation at npmjs.com. That owns the `@nearpays/` scope.
2. Publish the first version by hand, because npm links a trusted publisher
   to a package that already exists:

   ```bash
   npm ci
   npm login
   npm publish --provenance=false
   ```

   (Provenance needs CI, so it's off for this one manual publish. Every
   version after it is published by the workflow, with provenance.)
3. On npmjs.com, open the package → Settings → Trusted publishing, and add:
   GitHub Actions · organisation `nearpays` · repository `nearpays-partner-sdk` ·
   workflow `ci.yml` · environment `npm`.
4. In GitHub → Settings → Environments, create an environment named `npm`.
   Add required reviewers if you want a person to approve each publish.
5. Optional, recommended: on npmjs.com, set the package to require trusted
   publishing and disallow tokens, so nobody can publish from a laptop.

## Each release

Pick the version: `patch` for fixes, `minor` for new features, and while the
version is below 1.0.0, `minor` also for anything that breaks existing code.

```bash
npm version patch
git push --follow-tags
```

`npm version` updates `package.json` and `package-lock.json`, commits, and
tags `vX.Y.Z`.

The workflow tests, checks the tag matches `package.json`, builds and
publishes. If the tag and version disagree, it stops without publishing.

## Before 1.0.0

- The README's `https://<nearpays-api>` placeholders are replaced with the
  real API addresses.
- The SDK has run against production once.
- FYI is live on it.
