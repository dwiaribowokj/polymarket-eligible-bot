# Project instructions

- The canonical publication repository is
  `https://github.com/dwiaribowokj/polymarket-eligible-bot`.
  Push requested project changes there after validating the public diff.
- Publish only portable code, tests, documentation, and configuration templates
  with empty secret fields. Never push private deployment Git history, `.env` files, wallet
  information, credentials, `data/`, ledgers, logs, or operational incident notes.
- Use the allowlist in `scripts/release.js`. Run `npm run release:check`, stage
  only reviewed public changes, then run `node scripts/release.js check --staged`
  and inspect the staged diff before committing. Keep `core.hooksPath=.githooks`.
  Export private checkouts into a new directory; never merge their Git history.
- Keep live runtime, private configuration, and continuation state separate from
  public source publication. A source update does not authorize an automatic
  restart. Inspect the active runtime, reconcile wallet/ledger state, and follow
  the audited continuation or migration procedure before an authorized rollout.
  Never delete history or risk stops to force startup.
- Preserve the eligible, rule-based project identity and portable setup guides.
  The public template uses entry cap `0.85`; profit withdrawal is disabled and
  its recipient is empty. Keep private deployment settings out of templates.
- Use Node.js 24 and run tests relevant to each change. Report validation and
  distinguish published source changes from changes applied to a live runtime.
