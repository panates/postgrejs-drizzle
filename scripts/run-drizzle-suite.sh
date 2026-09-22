#!/usr/bin/env bash
#
# Runs drizzle-orm's own PostgreSQL integration suite against this driver,
# and against drizzle-orm/node-postgres in the same invocation.
#
# The suite (integration-tests/tests/pg/pg-common.ts) is parameterised by
# driver: every driver drizzle ships points it at itself and declares what
# it cannot pass through skipTests(). This runs it with no skips at all,
# twice - once on this driver and once on node-postgres - and fails only on
# a test this driver loses that node-postgres wins.
#
# The control run is the point. The suite asserts row order in three places
# without writing ORDER BY, so its score moves with the PostgreSQL version:
# 183/183 on the 14 its own createDockerDB() pins, 180/183 on 18. A fixed
# EXPECTED_FAILURES would be wrong on one of them; a control measured on the
# same server in the same run is right on both.
#
# Only the three files the suite needs are vendored, and drizzle-orm comes
# from npm rather than from a monorepo build - so what is tested is the
# published package a user would install.
#
# Everything lands in $WORK_DIR; nothing outside this repository is
# modified.
#
# Usage: scripts/run-drizzle-suite.sh
#   DRIZZLE_VERSION       npm version to test against (default: 0.45.3)
#   PG_CONNECTION_STRING  server to use; when unset, a postgres:14 container
#                         is started on a free port and removed at the end
#   WORK_DIR              where the checkout lives
#                         (default: $TMPDIR/drizzle-postgrejs-suite)
#   KEEP_CONTAINER        set to keep the container running afterwards
set -euo pipefail

DRIZZLE_VERSION="${DRIZZLE_VERSION:-0.45.3}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/drizzle-postgrejs-suite}"
SUITE_DIR="$WORK_DIR/suite"
SRC_DIR="$WORK_DIR/drizzle-orm-src"
# The image drizzle's own createDockerDB() pins (pg-common.ts).
PG_IMAGE="${PG_IMAGE:-postgres:14}"
CONTAINER_NAME="drizzle-postgrejs-suite-pg"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

started_container=
cleanup() {
  if [ -n "$started_container" ] && [ -z "${KEEP_CONTAINER:-}" ]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- database

if [ -z "${PG_CONNECTION_STRING:-}" ]; then
  command -v docker >/dev/null 2>&1 ||
    die "No PG_CONNECTION_STRING and no docker. Set one or install the other."
  say "Starting $PG_IMAGE"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  # Port 0 lets the daemon pick a free one, so a local server is left alone.
  docker run -d --name "$CONTAINER_NAME" \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=postgres -p 0:5432 "$PG_IMAGE" >/dev/null
  started_container=1
  PORT="$(docker port "$CONTAINER_NAME" 5432 | head -1 | sed 's/.*://')"
  : "${PORT:?the container published no host port}"
  ready=
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  : "${ready:?postgres did not become ready}"
  PG_CONNECTION_STRING="postgres://postgres:postgres@127.0.0.1:$PORT/postgres"
fi
say "Server: ${PG_CONNECTION_STRING//:*@/:***@}"

# --------------------------------------------------------- vendor the suite

say "drizzle-orm $DRIZZLE_VERSION in $SUITE_DIR"
mkdir -p "$WORK_DIR"
if [ ! -d "$SRC_DIR/.git" ]; then
  # A partial clone with no checkout: only the blobs actually asked for
  # below come down, which is three files out of a large monorepo.
  git clone --filter=blob:none --no-checkout --quiet \
    https://github.com/drizzle-team/drizzle-orm.git "$SRC_DIR"
fi
git -C "$SRC_DIR" fetch --tags --quiet
# `checkout <tag> -- <path>` rather than `sparse-checkout`, which needs a
# git newer than some of the machines this has to run on.
git -C "$SRC_DIR" checkout --quiet "$DRIZZLE_VERSION" -- integration-tests/tests

mkdir -p "$SUITE_DIR/tests/pg"
VENDORED="$SRC_DIR/integration-tests/tests"
for file in pg/pg-common.ts common.ts utils.ts; do
  cp "$VENDORED/$file" "$SUITE_DIR/tests/$file"
done
# pg-common.ts imports a type from this one and nothing else from it.
cat > "$SUITE_DIR/tests/pg/neon-http-batch.test.ts" <<'EOF'
export const schema = {} as any;
EOF

cat > "$SUITE_DIR/package.json" <<'EOF'
{ "name": "drizzle-postgrejs-suite", "private": true, "type": "module" }
EOF

cat > "$SUITE_DIR/vitest.config.ts" <<'EOF'
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '~': fileURLToPath(new URL('./tests', import.meta.url)) } },
  test: {
    include: [process.env.SUITE_FILE!],
    testTimeout: 60000,
    hookTimeout: 120000,
    pool: 'forks',
    fileParallelism: false,
  },
});
EOF

# The suite's own driver files build their client from a connection string.
# PostgreJS takes one as its first argument; `{ connectionString }` is not
# one of its options and would be ignored, landing on localhost:5432.
cat > "$SUITE_DIR/tests/pg/postgrejs.test.ts" <<'EOF'
import { afterAll, beforeAll, beforeEach } from 'vitest';
// @ts-ignore - the built package, installed into node_modules by the script
import { drizzle } from 'drizzle-postgrejs';
import { tests } from './pg-common';

let db: any;

beforeAll(() => {
  db = drizzle({
    connection: process.env['PG_CONNECTION_STRING']!,
    logger: false,
  });
});

afterAll(async () => {
  await db?.$client?.close();
});

beforeEach((ctx: any) => {
  ctx.pg = { db };
});

tests();
EOF

cat > "$SUITE_DIR/tests/pg/control.test.ts" <<'EOF'
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { tests } from './pg-common';

let client: Pool;
let db: any;

beforeAll(() => {
  client = new Pool({ connectionString: process.env['PG_CONNECTION_STRING'] });
  db = drizzle(client, { logger: false });
});

afterAll(async () => {
  await client?.end();
});

beforeEach((ctx: any) => {
  ctx.pg = { db };
});

tests();
EOF

# ----------------------------------------------------------- install, build

say "Installing the suite's dependencies"
# postgrejs is installed here as well as overlaid below: the overlay is
# only the package's own files, and its dependencies have to be resolvable
# from this node_modules rather than from wherever the copy came from.
(cd "$SUITE_DIR" && npm install --silent --no-audit --no-fund \
  "drizzle-orm@$DRIZZLE_VERSION" vitest@2 pg @types/pg @types/node \
  postgrejs dockerode get-port uuid)

say "Building this driver"
(cd "$REPO_DIR" && npm run build >/dev/null)

# A real directory rather than a link, so the driver resolves drizzle-orm
# and postgrejs from the suite's own node_modules - one copy of each, shared
# with what the suite itself runs on.
DEST="$SUITE_DIR/node_modules/drizzle-postgrejs"
rm -rf "$DEST"
cp -R "$REPO_DIR/build" "$DEST"
# The postgrejs under test is this repository's, not whatever npm resolved -
# which is the whole point when a local build is being tried out. Only the
# package's own files are replaced; its dependencies stay the ones npm just
# installed beside it.
rm -rf "$SUITE_DIR/node_modules/postgrejs"
cp -R "$REPO_DIR/node_modules/postgrejs" "$SUITE_DIR/node_modules/postgrejs"
node -e '
  const { execFileSync } = require("node:child_process");
  const suite = process.argv[1];
  const version = require(suite + "/node_modules/postgrejs/package.json").version;
  console.log("    postgrejs " + version + " (from this repository)");
' "$SUITE_DIR"

# ------------------------------------------------------------------ run it

run_suite() {
  local file="$1" out="$2"
  (cd "$SUITE_DIR" && \
    SUITE_FILE="$file" PG_CONNECTION_STRING="$PG_CONNECTION_STRING" \
    npx vitest run --reporter=json --outputFile="$out" >/dev/null 2>&1) || true
  [ -s "$out" ] || die "vitest produced no report for $file"
}

say "Running the suite on drizzle-orm/node-postgres (control)"
run_suite tests/pg/control.test.ts "$WORK_DIR/control.json"

say "Running the suite on this driver"
run_suite tests/pg/postgrejs.test.ts "$WORK_DIR/postgrejs.json"

say "Comparing"
node - "$WORK_DIR/control.json" "$WORK_DIR/postgrejs.json" <<'EOF'
import { readFileSync } from 'node:fs';

const read = (path, label) => {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const names = { label, passed: new Set(), failed: new Set() };
  for (const file of report.testResults ?? [])
    for (const test of file.assertionResults ?? [])
      names[test.status === 'passed' ? 'passed' : 'failed'].add(test.fullName);
  names.total = names.passed.size + names.failed.size;
  return names;
};

const control = read(process.argv[2], 'node-postgres (control)');
const ours = read(process.argv[3], 'drizzle-postgrejs');

// A run that collected nothing reports no failures, which would otherwise
// read as a clean sweep. The suite is 180-odd tests; zero means it did not
// run at all - an import that could not resolve, usually.
for (const run of [control, ours])
  if (run.total === 0) {
    console.error(`\n\x1b[31m  ${run.label} ran no tests at all.\x1b[0m`);
    console.error('  Re-run its file on its own to see why:');
    console.error('    cd $WORK_DIR/suite && SUITE_FILE=<file> npx vitest run');
    process.exit(1);
  }
if (control.total !== ours.total) {
  console.error(
    `\n\x1b[31m  The two runs collected different tests: ` +
      `${control.total} and ${ours.total}.\x1b[0m`,
  );
  process.exit(1);
}

const line = run =>
  `  ${run.label.padEnd(24)} ${String(run.passed.size).padStart(3)} / ${run.total}`;
console.log(line(control));
console.log(line(ours));

const regressions = [...ours.failed].filter(name => control.passed.has(name));
const shared = [...ours.failed].filter(name => control.failed.has(name));
const better = [...control.failed].filter(name => ours.passed.has(name));

if (shared.length) {
  console.log(`\n  ${shared.length} the control loses too - the suite's own, not ours:`);
  for (const name of shared) console.log(`    - ${name}`);
}
if (better.length) {
  console.log(`\n  ${better.length} this driver passes and the control does not:`);
  for (const name of better) console.log(`    + ${name}`);
}
if (regressions.length) {
  console.log(`\n\x1b[31m  ${regressions.length} this driver loses and the control wins:\x1b[0m`);
  for (const name of regressions) console.log(`    ! ${name}`);
  process.exit(1);
}
console.log('\n\x1b[32m  No test is lost here that node-postgres wins.\x1b[0m');
EOF
