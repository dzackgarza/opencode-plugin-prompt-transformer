install:
  bun install

typecheck:
  bunx tsc --noEmit

test:
  bun test

check: typecheck test
