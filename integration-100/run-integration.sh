#!/bin/bash
# Run in the integration worktree: combined suites, then each wrong order of `made` in the tail branch.
L=./logs; mkdir -p $L
T=(test/watch-tail-conditional.test.ts test/watch-conditional-reads.test.ts test/watch-tail.test.ts)
CORRECT=./correct-watches.ts
npx vitest run --project unit --maxWorkers=2 "${T[@]}" test/watches.test.ts test/follow.test.ts test/objects.test.ts test/definitions.test.ts test/connections.test.ts test/stored-shapes.test.ts test/watch-kinds.test.ts test/watch-decide.test.ts test/watch-cannot-follow.test.ts test/objects-integration.test.ts > $L/combined-suites.log 2>&1
echo "== correct order"; grep -E "×|Test Files|Tests " $L/combined-suites.log
read -r -d '' DEL <<'PY'
a = """				// a complete tail read is made: never one refused, nor one behind (its list stands as last read)
				if (read.unless !== undefined) made[as] = madeNow(read.unless, answers, base, now);
"""
line = "				if (read.unless !== undefined) made[as] = madeNow(read.unless, answers, base, now);\n"
p = 'src/core/watches.ts'; s = open(p).read(); assert s.count(a) == 1; s = s.replace(a, '')
PY
mut () {
  cp $CORRECT src/core/watches.ts
  python3 -c "$DEL
$2
open(p,'w').write(s)"
  git diff --no-index $CORRECT src/core/watches.ts > $L/mutation-$1.diff
  npx vitest run --project unit --maxWorkers=2 --reporter=verbose "${T[@]}" > $L/mutation-$1.log 2>&1
  echo "== $1"; grep -E "×|Tests " $L/mutation-$1.log | head -10
  cp $CORRECT src/core/watches.ts
}
mut made-on-behind "b = '				lengths[as] = tailed.length;\n'; assert s.count(b) == 1; s = s.replace(b, b + line)"
mut made-before-tail-read "b = '			if (read.tail !== undefined) {\n'; assert s.count(b) == 1; s = s.replace(b, b + line)"
mut made-missing-in-tail "pass"
cmp -s $CORRECT src/core/watches.ts && echo "== watches.ts restored to the correct order"
