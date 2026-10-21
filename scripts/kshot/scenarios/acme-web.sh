#!/bin/sh
# A small project for the readme-session scenario: a slugify module whose
# test fails on accented titles, in a git repository at DIR.
set -eu
dir=$1
mkdir -p "$dir/src" "$dir/test"
cd "$dir"
cat > package.json <<'EOF'
{
  "name": "acme-web",
  "type": "module",
  "scripts": { "test": "node test/slug.test.js" }
}
EOF
cat > src/slug.js <<'EOF'
export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
EOF
cat > test/slug.test.js <<'EOF'
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';

assert.equal(slugify('Hello, World'), 'hello-world');
assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
console.log('2 passed');
EOF
git init -q -b main
git add package.json src test
git -c user.email=kshot@example.com -c user.name=kshot commit -qm 'slugify'
