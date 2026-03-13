install:
  bun install

typecheck:
  bunx tsc --noEmit

test:
  bun test

check: typecheck test

# Setup npm trusted publisher (one-time manual setup)
setup-npm-trust:
    #!/usr/bin/env bash
    set -euo pipefail
    npm trust github --repository "dzackgarza/$(basename "{{justfile_directory()}}")" --file publish.yml

# Manual publish from local (requires 2FA)
publish:
    npm publish
