# Linux Doctor — editions & tiers

The repository you are looking at **is** the Free edition: the whole product
for everyday users, GPL-3.0-or-later, forever. There is no crippled code here,
no nag screens, and no hidden premium module — a guard test
(`tests/open-core.test.js`) fails the build if proprietary licensing or
premium checks ever leak into this tree.

## Editions

| | Free (this repo) | Pro add-on | Business | Enterprise |
|---|---|---|---|---|
| Who | everyday users | power users & sysadmins | teams | organizations |
| All free features | ✅ | ✅ | ✅ | ✅ |
| Premium checks (`hardening`, `scrub`, `boottime`, `connets`, `journalcap`) | — | ✅ | ✅ | ✅ |
| Alerting webhook (`--alert`), dead-man's switch (`--heartbeat`), scheduled agent (`--daemon`), advanced AI plans | — | ✅ | ✅ | ✅ |
| Hosted fleet dashboard, seats & machines, shared ignore policies | — | — | ✅ | ✅ |
| SSO/SCIM, on-prem fleet, SLA, volume licensing | — | — | — | ✅ |
| Proprietary-embedding rights (dual license) | — | — | — | ✅ |

Every tier includes everything to its left.

## How Pro is distributed (open-core)

Linux Doctor Pro is a separate, proprietary package (`@linux-doctor/pro`).
It is intentionally **not** on npm's public registry and not in any public
repository — that is what makes it genuinely unavailable for free:

- Buyers receive access via a private channel (GitHub Packages token or a
  signed download link) and install over this edition:
  ```bash
  npm login --registry=https://npm.pkg.github.com   # buyer token
  npm i -g @linux-doctor/pro
  ```
- The free core auto-discovers the installed module; air-gapped machines can
  point at its entry file directly:
  ```bash
  export LINUX_DOCTOR_PRO_MODULE=/opt/linux-doctor/pro/index.mjs
  ```
- License keys are verified inside the Pro package (the signing secret never
  touches open source). Keys are tied to the subscriber, not the machine.
- Without the module, this edition behaves identically whether or not a key
  string is present — a key alone unlocks nothing.

## Business & Enterprise

Both include everything in Pro; the differentiating features are delivered by
the maintainer's service (hosted fleet dashboard, team management, policies)
and, for Enterprise, on-prem deployment plus signed agreements for SLAs,
volume terms, and proprietary embedding of the community edition
(MySQL/Qt-style dual licensing).

**Like Pro, their implementations live only in private repositories.** No
paid-tier code is ever published publicly — this documentation describes
what each tier offers; it never ships its code.

## Contact

Open an issue on [GitHub](https://github.com/7sh1d0w7x/linux-doctor/issues)
or email the maintainer for pricing and terms.
